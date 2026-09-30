/**
 * Apify actor output -> candidates for the shared verification pipeline.
 *
 * Nothing here decides what is true. It maps an actor's payload into the same
 * candidate shape every other source produces, and lib/pipeline.js then applies
 * the identical rules: the alias must appear in the text, the date must be
 * provable, the link must resolve. A paid source gets no shortcut — that is the
 * point of having one pipeline.
 */
const { brand, brandOrder } = require("./brands");
const { toIsoDate, decodeEntities } = require("./verify");
const { firstAliasIn } = require("./freshsources");
const apify = require("./apify");

/* --------------------------------------------------------------------- X */

/**
 * X via apidojo/tweet-scraper.
 *
 * MEASURED: 5 tweets for "Document360" cost $0.0020 and included a genuine
 * third-party recommendation ("Document360 might be a good alternate to check
 * out. Their search works best.") dated the same day. twitterapi.io — the
 * previous route — is at -518 credits and answers 402 on every call, so this is
 * the only working route to X.
 */
async function sweepX({ brands, sinceMs, maxPerBrand = 20, log = () => {} }) {
  const candidates = [];
  const gaps = [];

  for (const id of brands) {
    const b = brand(id);
    const alias = b.aliases[0];

    const r = await apify.runActor("x", {
      searchTerms: [alias],
      maxItems: maxPerBrand,
      sort: "Latest",
    }, { maxItems: maxPerBrand, log });

    if (!r.ok) {
      gaps.push({ brand_id: id, reason: r.reason, budget_stop: !!r.budget_stop });
      // A budget stop applies to the whole account, so continuing would just
      // produce the same refusal six more times.
      if (r.budget_stop || r.skipped === "not_configured") break;
      continue;
    }

    let kept = 0;
    for (const t of r.items) {
      // Tweets arrive HTML-escaped ("&amp;", "&gt;"). The evidence excerpt is
      // quoted verbatim in the UI, so it must read as the author wrote it.
      const text = decodeEntities(t.text || t.full_text || "");
      const url = t.twitterUrl || t.url ||
        (t.author && t.author.userName && t.id ? `https://x.com/${t.author.userName}/status/${t.id}` : null);
      if (!text || !url) continue;

      const matched = firstAliasIn(text, id);
      if (!matched) continue;

      const published = toIsoDate(t.createdAt || t.created_at);
      if (published && sinceMs && Date.parse(published) < sinceMs) continue;

      candidates.push({
        brand_id: id,
        channel: "x",
        url,
        title: null,
        published_at: published,
        date_method: published ? "apify:tweet createdAt" : null,
        source_text: text,
        source_verified: true,
        source_adapter: "x_apify",
        discovered_via: `apify:${apify.ACTORS.x.id} "${alias}"`,
        author: (t.author && (t.author.name || t.author.userName)) || null,
        extra: {
          matched_alias: matched,
          author_handle: (t.author && t.author.userName) || null,
          likes: t.likeCount ?? null,
          retweets: t.retweetCount ?? null,
          replies: t.replyCount ?? null,
          views: t.viewCount ?? null,
          paid_source: "apify",
        },
      });
      kept++;
    }
    log(`      apify x: ${b.name} — ${kept} tweet(s)`);
  }

  return { candidates, gaps };
}

/* -------------------------------------------------------------- LinkedIn */

/**
 * LinkedIn via harvestapi/linkedin-post-search.
 *
 * A STRICT UPGRADE ON THE SERPAPI ROUTE, measured on the same brand:
 *
 *   SerpAPI site: query   finds posts, but Google's snippet carries NO DATE and
 *                         no author. 19 of 38 authors had to be recovered by
 *                         regex from page text; the rest stayed "unknown", and
 *                         every record was undated.
 *   this                  exact ISO timestamps (2026-09-29T14:02:37) and real
 *                         author names on every post, plus the full post body
 *                         rather than a truncated snippet.
 *
 * `postedLimit` takes an enum — "week", not "past-week". The wrong value
 * returns HTTP 400 and costs nothing, which is the good kind of failure.
 */
async function sweepLinkedIn({ brands, sinceMs, maxPerBrand = 10, log = () => {} }) {
  const candidates = [];
  const gaps = [];

  for (const id of brands) {
    const b = brand(id);
    const alias = b.aliases[0];

    const r = await apify.runActor("linkedin", {
      searchQueries: [alias],
      maxPosts: maxPerBrand,
      postedLimit: "week",
    }, { maxItems: maxPerBrand, log });

    if (!r.ok) {
      gaps.push({ brand_id: id, reason: r.reason, budget_stop: !!r.budget_stop });
      if (r.budget_stop || r.skipped === "not_configured") break;
      continue;
    }

    let kept = 0;
    for (const p of r.items) {
      const text = decodeEntities(p.content || p.text || "");
      const url = p.linkedinUrl || p.url || p.postUrl;
      if (!text || !url) continue;

      const matched = firstAliasIn(text, id);
      if (!matched) continue;

      const rawDate = (p.postedAt && (p.postedAt.date || p.postedAt.timestamp)) || p.postedAt || null;
      const published = toIsoDate(rawDate);
      if (published && sinceMs && Date.parse(published) < sinceMs) continue;

      candidates.push({
        brand_id: id,
        channel: "linkedin",
        url,
        title: null,
        published_at: published,
        date_method: published ? "apify:linkedin postedAt" : null,
        source_text: text,
        source_verified: true,
        source_adapter: "linkedin_apify",
        discovered_via: `apify:${apify.ACTORS.linkedin.id} "${alias}"`,
        author: (p.author && (p.author.name || p.author.publicIdentifier)) || null,
        extra: {
          matched_alias: matched,
          author_headline: (p.author && p.author.headline) || null,
          author_url: (p.author && p.author.linkedinUrl) || null,
          reactions: p.engagement ? (p.engagement.likes ?? p.engagement.reactions ?? null) : null,
          comments: p.engagement ? (p.engagement.comments ?? null) : null,
          paid_source: "apify",
        },
      });
      kept++;
    }
    log(`      apify linkedin: ${b.name} — ${kept} post(s)`);
  }

  return { candidates, gaps };
}

/**
 * Both channels, paced and budget-guarded as one unit.
 *
 * Paced together rather than per-channel: the budget is one account balance, so
 * two independently-paced sweeps would drain it twice as fast while each
 * believed it was being careful.
 */
async function sweep({ brands = null, sinceMs = null, force = false, log = () => {} } = {}) {
  const out = { candidates: [], gaps: [], ran: false, reason: null, throttled: false };

  const cred = apify.credentialStatus();
  if (!cred.ok) { out.reason = cred.reason; return out; }

  const pace = apify.pacing({ force });
  if (!pace.ok) {
    out.throttled = true;
    out.reason = pace.reason;
    log(`      apify: ${pace.reason}`);
    return out;
  }

  const ids = brands && brands.length ? brands.filter(x => brandOrder().includes(x)) : brandOrder();

  const x = await sweepX({ brands: ids, sinceMs, log });
  out.candidates.push(...x.candidates);
  out.gaps.push(...x.gaps);

  const li = await sweepLinkedIn({ brands: ids, sinceMs, log });
  out.candidates.push(...li.candidates);
  out.gaps.push(...li.gaps);

  apify.markSweep();
  out.ran = true;
  return out;
}

module.exports = { sweep, sweepX, sweepLinkedIn };
