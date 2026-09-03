/**
 * Adapter: Octolens Social Listening  →  primary social/web listening source
 * API: POST https://app octolens.com/api/v2/mentions   (Bearer OCTOLENS_API_KEY)
 *
 * VERIFIED AGAINST THE LIVE API on 2026-08-31. Findings that shape this adapter,
 * recorded because they bound what the dashboard can honestly claim:
 *
 *   Base URL      app.octolens.com/api/v2/mentions works.
 *                 api.octolens.com returns Vercel DEPLOYMENT_NOT_FOUND — the
 *                 docs list it, but it is not live.
 *   Auth          Authorization: Bearer <key>
 *   Pagination    cursor-based: response.pagination.nextCursor, echoed back as
 *                 `cursor`. Followed to exhaustion here.
 *   Fields        id, sourceId, url, title, body, source, timestamp, author,
 *                 authorName, authorAvatar, authorUrl, authorFollowers,
 *                 relevance, relevanceComment, sentiment, language, tags,
 *                 keywords[{id,keyword,keywordTag}], engaged, relevanceScore,
 *                 feedbackRelevant, imageUrl
 *
 * THE COVERAGE LIMIT THAT MATTERS MOST
 * ------------------------------------
 * Octolens returns mentions for keywords configured in the ACCOUNT, not for
 * arbitrary queries. This account tracks exactly three:
 *
 *     Mintlify (51)   document360 (11)   Gitbook (10)      — 69 mentions total
 *
 * So Octolens can cover 3 of the 7 tracked products and NOTHING for Confluence,
 * Guru, Bloomfire or KnowledgeOwl. Observed history was ~7 days (Aug 24-31), and
 * observed sources were twitter, github, reddit, youtube — no LinkedIn,
 * Instagram or Facebook.
 *
 * Those four products and three channels are reported as UNAVAILABLE-from-this-
 * source rather than as zero, because "the account does not watch this keyword"
 * and "nobody mentioned this product" are different facts. Adding keywords is a
 * change in the Octolens dashboard, not something this API can do.
 */
const { load } = require("../lib/env");
const { fetchUrl } = require("../lib/fetch");
const { allBrands, brandOrder, matchBrand, brand } = require("../lib/brands");
const {
  channelFromSource, classifyType, detectBuyingIntent,
  detectComparisons, detectEvent, normaliseSentiment, normaliseRelevance,
} = require("../lib/classify");
const { toIsoDate } = require("../lib/verify");

load();

const HOST = "app.octolens.com";
const PATH = "/api/v2/mentions";
const PAGE_LIMIT = 50;
const MAX_PAGES = 40; // safety stop; 69 mentions currently fits in 2

function credentialStatus() {
  const key = process.env.OCTOLENS_API_KEY || "";
  if (!key) {
    return {
      ok: false,
      reason: "OCTOLENS_API_KEY not set — Octolens is not connected.",
      how_to_enable: "Add OCTOLENS_API_KEY to .env, then run: npm run collect",
    };
  }
  return { ok: true, reason: null };
}

/** POST one page. Returns { ok, data, nextCursor, error }. */
async function fetchPage(cursor) {
  const body = JSON.stringify(cursor ? { limit: PAGE_LIMIT, cursor } : { limit: PAGE_LIMIT });
  const r = await fetchUrl(`https://${HOST}${PATH}`, {
    method: "POST",
    body,
    accept: "application/json",
    headers: {
      Authorization: `Bearer ${process.env.OCTOLENS_API_KEY}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    timeout: 40000,
    retries: 1,
  });
  if (!r.ok) return { ok: false, data: [], nextCursor: null, error: `HTTP ${r.status}` };
  let j = null;
  try { j = JSON.parse(r.body); } catch (e) {
    return { ok: false, data: [], nextCursor: null, error: "non-JSON response" };
  }
  return {
    ok: true,
    data: Array.isArray(j.data) ? j.data : [],
    nextCursor: (j.pagination && j.pagination.nextCursor) || null,
    error: null,
  };
}

/**
 * Which tracked product is this mention about?
 *
 * Octolens supplies the matched keyword, which is a strong signal — but it is a
 * keyword match, so it inherits the same false-positive risk as any keyword
 * (and "Gitbook" vs "GitBook" differs in case). So the keyword is used to
 * NOMINATE a product and the disambiguating matcher then CONFIRMS it against the
 * mention text. Confidence reflects which of those agreed.
 */
function resolveProduct(m) {
  const text = [m.title, m.body, m.relevanceComment].filter(Boolean).join(". ");
  const kws = (m.keywords || []).map(k => String(k.keyword || "").toLowerCase());

  const nominated = [];
  for (const id of brandOrder()) {
    const aliases = brand(id).aliases.map(a => a.toLowerCase());
    if (kws.some(k => aliases.some(a => k.includes(a) || a.includes(k)))) nominated.push(id);
  }

  // Confirm each nominee against the text with full disambiguation.
  const confirmed = [];
  for (const id of nominated) {
    const mm = matchBrand(text, id);
    if (mm.present) confirmed.push({ id, match: mm, via: "keyword+text" });
  }

  // Nothing nominated (or nothing confirmed)? Fall back to matching the text
  // against all seven — the account may surface a product incidentally.
  if (!confirmed.length) {
    for (const id of brandOrder()) {
      const mm = matchBrand(text, id);
      if (mm.present) confirmed.push({ id, match: mm, via: "text-only" });
    }
  }

  return confirmed.map(c => ({
    ...c,
    // keyword AND text agreeing is the strongest evidence available here.
    confidence: c.via === "keyword+text" ? 0.95 : 0.7,
  }));
}

module.exports = {
  id: "octolens",
  label: "Octolens Social Listening",
  channel: "multi",
  requires: ["OCTOLENS_API_KEY"],
  credentialStatus,
  available() { return credentialStatus(); },

  coverageLimit: {
    note:
      "Octolens returns mentions for keywords configured in the account, not arbitrary queries. " +
      "This account tracks Mintlify, document360 and Gitbook only, so Confluence, Guru, Bloomfire " +
      "and KnowledgeOwl get NO coverage from this source. Observed history ~7 days; observed sources " +
      "twitter, github, reddit, youtube — no LinkedIn, Instagram or Facebook.",
    tracked_keywords_observed: ["Mintlify", "document360", "Gitbook"],
    products_not_covered: ["confluence", "guru", "bloomfire", "knowledgeowl"],
    channels_not_observed: ["linkedin", "instagram", "facebook"],
  },

  connectionStatus() {
    const c = credentialStatus();
    return {
      id: "octolens",
      label: "Octolens Social Listening",
      connected: c.ok,
      blockers: c.ok ? [] : [c.reason],
      how_to_enable: c.how_to_enable || null,
      fallback_in_use: null,
    };
  },

  async collect({ sinceDays = 90, brands = null, log = () => {} } = {}) {
    const cred = credentialStatus();
    if (!cred.ok) {
      log(`    dormant: ${cred.reason}`);
      return { candidates: [], gaps: [{ brand_id: null, reason: cred.reason }], unavailable: true };
    }

    const cutoff = new Date(Date.now() - sinceDays * 864e5);
    const candidates = [];
    const gaps = [];
    const stats = {
      pages: 0, raw: 0, out_of_window: 0,
      unresolved_product: 0, irrelevant: 0,
      by_source: {}, by_keyword: {}, api_errors: [],
    };

    let cursor = null;
    while (stats.pages < MAX_PAGES) {
      const page = await fetchPage(cursor);
      stats.pages++;
      if (!page.ok) {
        stats.api_errors.push(page.error);
        gaps.push({ brand_id: null, reason: `Octolens API error on page ${stats.pages}: ${page.error}` });
        break;
      }
      if (!page.data.length) break;
      stats.raw += page.data.length;

      for (const m of page.data) {
        stats.by_source[m.source] = (stats.by_source[m.source] || 0) + 1;
        (m.keywords || []).forEach(k => {
          stats.by_keyword[k.keyword] = (stats.by_keyword[k.keyword] || 0) + 1;
        });

        if (!m.url) continue;
        const published = toIsoDate(m.timestamp);
        if (published && new Date(published) < cutoff) { stats.out_of_window++; continue; }

        // Octolens' own relevance judgement — respect it rather than re-deciding.
        if (String(m.relevance || "").toLowerCase() === "irrelevant") { stats.irrelevant++; continue; }

        const text = [m.title, m.body].filter(Boolean).join(". ");
        const resolved = resolveProduct(m);
        if (!resolved.length) { stats.unresolved_product++; continue; }

        for (const res of resolved) {
          if (brands && !brands.includes(res.id)) continue;

          const type = classifyType(text, m.tags);
          const intent = detectBuyingIntent(text, m.tags);
          const ev = detectEvent(text, m.tags);
          const cmp = detectComparisons(text, res.id);
          const channel = ev.is_sponsorship || ev.is_event
            ? "event"
            : channelFromSource(m.source, m.url);

          candidates.push({
            brand_id: res.id,
            channel,
            url: m.url,
            title: m.title || null,
            published_at: published,
            date_method: published ? "octolens:timestamp" : null,
            // Octolens' body IS the mention text and came from their crawl, so it
            // is legitimate evidence attributed to them.
            source_text: m.body || null,
            source_verified: true,
            source_adapter: "octolens",
            discovered_via: `octolens POST ${PATH}`,
            author: m.authorName || m.author || null,

            api_source: "octolens",
            // Sentiment comes from Octolens — attributed, not recomputed.
            sentiment: normaliseSentiment(m.sentiment),
            sentiment_method: m.sentiment ? "octolens (provider-supplied)" : null,
            relevance_score: normaliseRelevance(m.relevance, m.relevanceScore),
            relevance_comment: m.relevanceComment || null,
            confidence_score: res.confidence,
            mention_type: type.type,
            mention_type_basis: `${type.by}: ${type.matched || type.type}`,
            buying_intent: intent.intent,
            buying_intent_basis: intent.matched,
            comparison_products: cmp,
            is_event: ev.is_event,
            is_sponsorship: ev.is_sponsorship,
            event_basis: ev.matched,
            provider_tags: m.tags || [],
            engagement: {
              author_followers: m.authorFollowers ?? null,
              engaged: !!m.engaged,
            },
            extra: {
              octolens_id: m.id,
              octolens_source: m.source,
              source_id: m.sourceId || null,
              author_url: m.authorUrl || null,
              language: m.language || null,
              matched_keywords: (m.keywords || []).map(k => k.keyword),
              product_resolution: res.via,
            },
          });
        }
      }

      cursor = page.nextCursor;
      if (!cursor) break;
    }

    // Report per-product coverage honestly: a product this account does not watch
    // is UNAVAILABLE from Octolens, which is not the same as having no mentions.
    const covered = new Set(candidates.map(c => c.brand_id));
    for (const b of allBrands()) {
      if (covered.has(b.id)) continue;
      const watched = Object.keys(stats.by_keyword).some(k =>
        b.aliases.some(a => k.toLowerCase().includes(a.toLowerCase()))
      );
      gaps.push({
        brand_id: b.id,
        reason: watched
          ? `Octolens watches a keyword for ${b.name} but returned no in-window mentions.`
          : `NOT COVERED by Octolens: this account tracks only [${Object.keys(stats.by_keyword).join(", ") || "none"}]. ` +
            `${b.name} is not a tracked keyword, so this is "not measured", not zero. ` +
            `Add the keyword in the Octolens dashboard to enable coverage.`,
      });
    }

    log(`    ${candidates.length} candidates from ${stats.raw} raw over ${stats.pages} page(s)`);
    log(`    sources: ${Object.entries(stats.by_source).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
    log(`    keywords: ${Object.entries(stats.by_keyword).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
    if (stats.out_of_window) log(`    ${stats.out_of_window} outside the ${sinceDays}d window`);
    if (stats.irrelevant) log(`    ${stats.irrelevant} marked irrelevant by Octolens`);
    if (stats.unresolved_product) log(`    ${stats.unresolved_product} could not be resolved to a tracked product`);

    return { candidates, gaps, providerStats: stats };
  },

  _fetchPage: fetchPage,
};
