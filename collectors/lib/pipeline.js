/**
 * The single verification pipeline.
 *
 * Adapters do ONE job: discover candidate items (url + whatever the source
 * authoritatively knows). They never decide whether something counts. This file
 * does, for every adapter identically, so accuracy rules cannot drift between
 * sources.
 *
 * candidate -> fetch item URL -> confirm brand in text -> extract date+evidence -> record
 *
 * Feed-sourced candidates carry an authoritative date and their own text, so if
 * the item URL is unreachable the record can still be source_verified. It is
 * then flagged as a broken link rather than dropped, because "GitBook published
 * this and the link is now dead" is itself useful competitive intelligence.
 */
const { fetchUrl, pool } = require("./fetch");
const {
  htmlToText,
  extractPublishedDate,
  extractTitle,
  extractEvidence,
  canonicalUrl,
  domainOf,
  dateFromUrl,
} = require("./verify");
const { matchBrand } = require("./brands");
const { makeRecord } = require("./record");

/**
 * URLs that can never be a mention, regardless of what an adapter claims.
 * These exist because a redirect-resolution bug once stored a
 * lh3.googleusercontent.com image URL as a "Confluence mention". A business user
 * clicking a citation must land on an article, so asset hosts, tracking hosts and
 * unresolved aggregator tokens are rejected structurally rather than by review.
 */
const NON_ARTICLE_URL = new RegExp(
  [
    "news\\.google\\.com/rss",          // unresolved Google News token
    "googleusercontent\\.com",           // image/asset CDN
    "gstatic\\.com",
    "google-analytics\\.com",
    "policies\\.google\\.com",
    "support\\.google\\.com/(?:news|websearch)",
    "doubleclick\\.net",
    "facebook\\.com/tr",
    "\\.(?:png|jpe?g|gif|svg|webp|ico|css|js|woff2?|mp4|zip|pdf)(?:$|\\?)",
  ].join("|"),
  "i"
);

/** Evidence must be substantive enough for a human to audit the call. */
const MIN_EVIDENCE_CHARS = 40;

/**
 * A MENTION is a piece of content that talks about the brand. A profile page, a
 * hashtag index, a tag archive or the brand's own login screen is NOT a mention —
 * it merely contains the name.
 *
 * This gate exists because search discovery returned a lot of these and they were
 * being counted, which inflated every figure while adding nothing a business user
 * could act on. Measured examples that were being stored as "mentions":
 *   x.com/saravanamv                       a person's profile
 *   x.com/hashtag/technicaldocumentation    a hashtag index
 *   x.com/mintlify                          the brand's own profile
 *   linkedin.com/in/carolyn-tsiang          a personal profile
 *   linkedin.com/showcase/document360/      the brand's own showcase page
 *   identity.document360.io/Account/Login   the product's login screen
 *
 * Each rejection is recorded with a reason, so this is auditable and tunable
 * rather than a silent cull.
 */
function nonContentReason(url) {
  let u;
  try { u = new URL(url); } catch (e) { return "unparseable URL"; }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const path = u.pathname.replace(/\/+$/, "") || "/";

  // --- X / Twitter ---
  if (/(^|\.)(x|twitter)\.com$/.test(host)) {
    if (/^\/hashtag\//i.test(path)) return "X hashtag index page, not a post";
    if (/^\/(search|explore|i|intent|share)(\/|$)/i.test(path)) return "X search/system page, not a post";
    // A real post is /<handle>/status/<id>
    if (!/\/status(?:es)?\/\d+/i.test(path)) return "X profile page, not a post";
  }

  // --- LinkedIn ---
  if (/(^|\.)linkedin\.com$/.test(host)) {
    if (/^\/in\//i.test(path)) return "LinkedIn personal profile, not a post";
    if (/^\/(company|showcase|products|school)\//i.test(path) && !/\/posts?\//i.test(path)) {
      return "LinkedIn company/showcase/product page, not a post";
    }
    if (/^\/(jobs|learning|pulse\/topics|directory|legal|help)(\/|$)/i.test(path)) {
      return "LinkedIn jobs/system page, not a post";
    }
    // Accept /posts/, /feed/update/, /pulse/<article>
    if (!/\/(posts?|feed\/update|pulse)\//i.test(path)) return "LinkedIn non-post page";
  }

  // --- YouTube ---
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) {
    const isVideo = /^\/watch$/i.test(path) || /^\/shorts\//i.test(path) || host === "youtu.be";
    if (!isVideo) return "YouTube channel/playlist page, not a video";
  }

  // --- Instagram / Facebook / TikTok profile roots ---
  if (/(^|\.)instagram\.com$/.test(host) && !/^\/(p|reel|tv)\//i.test(path)) {
    return "Instagram profile/index page, not a post";
  }
  if (/(^|\.)tiktok\.com$/.test(host) && !/\/video\/\d+/i.test(path)) {
    return "TikTok profile page, not a video";
  }

  // --- Generic index / archive / system pages on any host ---
  if (/^\/(tag|tags|category|categories|author|authors|topic|topics|search|page)(\/|$)/i.test(path)) {
    return "tag/category/author index page, not an article";
  }
  if (/\/(login|signin|sign-in|signup|register|account|auth|logout|cart|checkout)(\/|$)/i.test(path)) {
    return "login/account/system page, not content";
  }
  if (path === "/" ) return "site homepage, not a specific mention";

  return null;
}

/**
 * Turn candidates into records, fetching and verifying each one.
 *
 * @param candidates array of {
 *   brand_id, channel, url, title?, published_at?, date_method?,
 *   source_text?         // authoritative text from a feed/API entry
 *   source_verified?     // true when the containing feed/API returned 2xx
 *   trust_source_text?   // default true. Set FALSE when source_text did not come
 *                        // from fetched bytes — e.g. the legacy snapshot's
 *                        // snippets, which were written by an earlier LLM pass
 *                        // and are exactly the unauditable content this rebuild
 *                        // exists to remove. Such candidates must earn their
 *                        // evidence from a live page fetch or be rejected.
 *   source_adapter, discovered_via?, author?, extra?
 * }
 * @param opts { concurrency, verifyUrls, aliasesFor, onProgress }
 */
async function verifyCandidates(candidates, opts = {}) {
  const {
    concurrency = 16,
    verifyUrls = true,
    log = () => {},
  } = opts;

  // Deduplicate before spending HTTP requests.
  const seen = new Set();
  const unique = [];
  const rejections = [];
  let rejectedNonArticle = 0;
  let rejectedNonContent = 0;
  for (const c of candidates) {
    if (!c || !c.url || !c.brand_id) continue;
    if (NON_ARTICLE_URL.test(c.url)) {
      rejectedNonArticle++;
      rejections.push({
        url: c.url,
        brand_id: c.brand_id,
        adapter: c.source_adapter,
        reason: "not an article URL (asset host, tracker, or unresolved aggregator token)",
      });
      continue;
    }
    const ncr = nonContentReason(c.url);
    if (ncr) {
      rejectedNonContent++;
      rejections.push({
        url: c.url,
        brand_id: c.brand_id,
        adapter: c.source_adapter,
        reason: ncr,
      });
      continue;
    }
    const cu = canonicalUrl(c.url);
    const key = `${c.brand_id}::${c.channel}::${cu}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...c, canonical_url: cu });
  }

  const stats = {
    candidates: candidates.length,
    unique: unique.length,
    fetched: 0,
    fetch_failed: 0,
    verified: 0,
    rejected_non_article: rejectedNonArticle,
    rejected_non_content: rejectedNonContent,
    rejected_no_mention: 0,
    rejected_no_evidence: 0,
    dated: 0,
  };

  const records = await pool(unique, concurrency, async c => {
    let receipt = null;
    let pageText = "";

    if (verifyUrls) {
      receipt = await fetchUrl(c.url);
      if (receipt.ok) {
        stats.fetched++;
        pageText = htmlToText(receipt.body);
      } else {
        stats.fetch_failed++;
      }
    }

    // Evidence and mention confirmation prefer the live page, then fall back to
    // authoritative feed text. Never to anything we did not fetch.
    const trustSource = c.trust_source_text !== false;
    const feedText = trustSource ? [c.title, c.source_text].filter(Boolean).join(". ") : "";
    const primary = pageText && pageText.length > 200 ? pageText : "";
    const basis = primary || feedText;
    const basisKind = primary ? "page" : (feedText ? "feed" : null);

    if (!basis) {
      rejections.push({
        url: c.url,
        brand_id: c.brand_id,
        adapter: c.source_adapter,
        reason: receipt
          ? (trustSource
              ? `no usable text (HTTP ${receipt.status})`
              : `page unreachable (HTTP ${receipt.status}) and its stored snippet is not fetched evidence`)
          : "no text available",
      });
      return null;
    }

    const m = matchBrand(basis, c.brand_id);
    // If the live page didn't confirm but the feed text does, accept the feed
    // basis — common when a page renders its content client-side.
    let usedBasis = basis;
    let usedKind = basisKind;
    let match = m;
    if (!m.present && primary && feedText) {
      const m2 = matchBrand(feedText, c.brand_id);
      if (m2.present) {
        match = m2;
        usedBasis = feedText;
        usedKind = "feed";
      }
    }

    if (!match.present) {
      stats.rejected_no_mention++;
      rejections.push({
        url: c.url,
        brand_id: c.brand_id,
        adapter: c.source_adapter,
        reason: match.rejected_reason || "brand not confirmed in text",
      });
      return null;
    }

    const aliases = require("./brands").brand(c.brand_id).aliases;
    const ev = extractEvidence(usedBasis, aliases, 420);
    // An excerpt too short to read is not auditable evidence, so it is not
    // allowed to support a countable record.
    const evidenceText = ev ? ev.excerpt.replace(/^…|…$/g, "").trim() : "";

    // Final guarantee: the excerpt must itself contain a brand alias. Claude is
    // asked to judge sentiment from this text alone, so an excerpt that never
    // names the brand would make an unanswerable question — and any answer to it
    // would necessarily be invented.
    const evidenceNamesBrand =
      ev && aliases.some(a => ev.excerpt.toLowerCase().includes(String(a).toLowerCase()));

    if (!ev || evidenceText.length < MIN_EVIDENCE_CHARS || !evidenceNamesBrand) {
      stats.rejected_no_evidence++;
      rejections.push({
        url: c.url,
        brand_id: c.brand_id,
        adapter: c.source_adapter,
        reason: ev
          ? `evidence excerpt too short to audit (${evidenceText.length} < ${MIN_EVIDENCE_CHARS} chars)`
          : "no verbatim excerpt extractable",
      });
      return null;
    }

    // Date, in order of reliability:
    //   1. authoritative source date (feed/API)
    //   2. parsed from the fetched page
    //   3. derived from the URL — exact for X snowflake IDs and path dates, and
    //      the only option for pages that expose no machine-readable date at all
    //      (which was 34% of search-discovered records).
    let published_at = c.published_at || null;
    let date_method = c.published_at ? (c.date_method || "source feed/api") : null;
    if (!published_at && receipt && receipt.ok) {
      const d = extractPublishedDate(receipt.body);
      if (d.date) {
        published_at = d.date;
        date_method = "page:" + d.method;
      }
    }
    if (!published_at) {
      const du = dateFromUrl(c.url);
      if (du.date) {
        published_at = du.date;
        date_method = du.method;
      }
    }
    if (published_at) stats.dated++;

    const title =
      c.title ||
      (receipt && receipt.ok ? extractTitle(receipt.body) : null) ||
      null;

    return makeRecord({
      brand_id: c.brand_id,
      channel: c.channel,
      url: c.url,
      canonical_url: c.canonical_url,
      domain: domainOf(c.url),
      title,
      author: c.author || null,
      published_at,
      date_method,
      evidence: ev.excerpt,
      evidence_source: usedKind === "page" ? "fetched page text" : "source feed/api entry",
      source_adapter: c.source_adapter,
      discovered_via: c.discovered_via || null,
      http_status: receipt ? receipt.status : null,
      fetched_at: receipt ? receipt.fetched_at : new Date().toISOString(),
      content_sha256: receipt ? receipt.content_sha256 : null,
      url_verified: !!(receipt && receipt.ok),
      source_verified: !!c.source_verified,
      verification_method: usedKind,
      mention_confirmed: true,
      matched_alias: match.matched_alias,
      match_context_term: match.context_term || null,
      occurrences: match.occurrences,

      /* Provider + classification fields, forwarded from the adapter.
       *
       * Sentiment is the one that needs care: a provider-supplied label
       * (Octolens ships one) is kept and attributed, while an adapter that
       * supplies none leaves it null so Claude classifies it later from the
       * evidence excerpt. Nothing here invents a sentiment.
       */
      api_source: c.api_source || c.source_adapter,
      sentiment: c.sentiment || null,
      sentiment_method: c.sentiment_method || null,
      relevance_score: c.relevance_score ?? null,
      relevance_comment: c.relevance_comment || null,
      // Confidence in PRODUCT resolution. An adapter's own estimate is raised
      // when the page fetch independently confirmed the brand, because two
      // agreeing signals are stronger than one.
      confidence_score:
        typeof c.confidence_score === "number"
          ? Math.min(1, c.confidence_score + (usedKind === "page" ? 0.05 : 0))
          : (usedKind === "page" ? 0.9 : 0.75),
      mention_type: c.mention_type || null,
      mention_type_basis: c.mention_type_basis || null,
      buying_intent: !!c.buying_intent,
      buying_intent_basis: c.buying_intent_basis || null,
      comparison_products: c.comparison_products || [],
      is_event: !!c.is_event,
      is_sponsorship: !!c.is_sponsorship,
      event_basis: c.event_basis || null,
      engagement: c.engagement || null,
      provider_tags: c.provider_tags || [],

      extra: c.extra || {},
    });
  });

  const built = records.filter(r => r && !r.__error);

  // Only records that actually pass the verification gate are returned. A record
  // built from feed text whose URL is dead AND whose source was never proven is
  // dropped here, so `verified` in the log means exactly what the dashboard counts.
  const { isVerified } = require("./record");
  const clean = [];
  for (const r of built) {
    if (isVerified(r)) {
      clean.push(r);
      continue;
    }
    rejections.push({
      url: r.url,
      brand_id: r.brand_id,
      adapter: r.source_adapter,
      reason: require("./record").rejectionReason(r) || "failed verification gate",
    });
  }
  stats.verified = clean.length;
  stats.built_but_unverified = built.length - clean.length;
  stats.link_healthy = clean.filter(r => r.url_verified).length;

  log(
    `    ${stats.verified} verified / ${stats.unique} unique candidates ` +
      `(${stats.dated} dated, ${stats.link_healthy} live links, ` +
      `${stats.fetch_failed} unfetchable, ${stats.rejected_no_mention} no-mention, ` +
      `${stats.rejected_no_evidence} no-evidence, ${stats.rejected_non_article} non-article, ${stats.rejected_non_content} non-content)`
  );
  return { records: clean, stats, rejections };
}

module.exports = { verifyCandidates, nonContentReason };
