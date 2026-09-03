/**
 * Adapter: NewsAPI  →  complementary news / blog / web source
 * API: GET https://newsapi.org/v2/everything   (apiKey query param or header)
 *
 * VERIFIED AGAINST THE LIVE API on 2026-08-31. Real per-product coverage, which
 * is the number that matters rather than the headline totalResults:
 *
 *     Document360      1 article
 *     Mintlify         8
 *     GitBook          2
 *     Bloomfire        1
 *     KnowledgeOwl     0
 *     Confluence     484 totalResults  <-- almost entirely the English word
 *     Guru           887 totalResults  <-- almost entirely "guru" as in expert
 *
 * THE FALSE-POSITIVE PROBLEM IS THE WHOLE STORY HERE
 * --------------------------------------------------
 * Sampling the Confluence and Guru results and running them through the
 * disambiguating matcher rejected 12 of 12: Nepal flood coverage, a Razer mouse
 * review, concert listings, a marketing job ad. Taking NewsAPI's counts at face
 * value would put ~1,300 fabricated "mentions" into the dashboard and wreck every
 * share-of-voice figure.
 *
 * So every article is gated twice: once here on title+description+content, and
 * again in the pipeline on the fetched page text. Rejections are recorded with
 * their reason so the cull is auditable.
 *
 * FREE-TIER LIMITS (stated because they bound the date ranges)
 *   - roughly one month of history, so the 90d and 365d windows are thinner from
 *     this source than from the RSS feeds
 *   - 100 articles per query maximum
 *   - 100 requests/day
 *   - the key is sent as an X-Api-Key HEADER, never in a URL that could be logged
 */
const { load } = require("../lib/env");
const { fetchUrl } = require("../lib/fetch");
const { allBrands, searchTerms, matchBrand, brand: brandCfg } = require("../lib/brands");
const {
  channelFromSource, classifyType, detectBuyingIntent,
  detectComparisons, detectEvent,
} = require("../lib/classify");
const { toIsoDate, domainOf } = require("../lib/verify");

load();

const PAGE_SIZE = 100;
// Free tier serves PAGE 1 ONLY — page 2 returns HTTP 426 "Upgrade Required"
// (observed twice in one run). Requesting it just logs an error for no data, so
// the cap is 1 and the limit is reported as a coverage gap instead.
const MAX_PAGES = 1;
const MAX_HISTORY_DAYS = 30;  // free tier

function credentialStatus() {
  const key = process.env.NEWSAPI_KEY || "";
  if (!key) {
    return {
      ok: false,
      reason: "NEWSAPI_KEY not set — NewsAPI is not connected.",
      how_to_enable: "Add NEWSAPI_KEY to .env, then run: npm run collect",
    };
  }
  return { ok: true, reason: null };
}

/** Domains that publish syndicated aggregator copies rather than original reporting. */
const AGGREGATOR = /(^|\.)(?:news-?break|newsbreak|biztoc|msn|finanzen|marketscreener|menafn|streetinsider|investing\.com)\b/i;

async function fetchPage(query, page, fromIso) {
  const params = new URLSearchParams({
    q: query,
    pageSize: String(PAGE_SIZE),
    page: String(page),
    language: "en",
    sortBy: "publishedAt",
  });
  if (fromIso) params.set("from", fromIso);

  const r = await fetchUrl(`https://newsapi.org/v2/everything?${params.toString()}`, {
    accept: "application/json",
    // Header auth, so the key never appears in a URL that could end up in a log.
    headers: { "X-Api-Key": process.env.NEWSAPI_KEY },
    timeout: 30000,
    retries: 1,
  });
  if (!r.ok) return { ok: false, articles: [], total: 0, error: `HTTP ${r.status}` };
  let j = null;
  try { j = JSON.parse(r.body); } catch (e) {
    return { ok: false, articles: [], total: 0, error: "non-JSON response" };
  }
  if (j.status !== "ok") {
    return { ok: false, articles: [], total: 0, error: `${j.code}: ${String(j.message).slice(0, 120)}` };
  }
  return { ok: true, articles: j.articles || [], total: j.totalResults || 0, error: null };
}

module.exports = {
  id: "newsapi",
  label: "NewsAPI (news/blog/web)",
  channel: "multi",
  requires: ["NEWSAPI_KEY"],
  credentialStatus,
  available() { return credentialStatus(); },

  coverageLimit: {
    max_days: MAX_HISTORY_DAYS,
    note:
      `NewsAPI's free tier serves roughly ${MAX_HISTORY_DAYS} days of history and caps each query at 100 ` +
      "articles, so 90-day and 365-day windows are thinner from this source than from the RSS feeds. " +
      "Its raw counts for Confluence (484) and Guru (887) are overwhelmingly the English words, not the " +
      "products — a 12-of-12 sample was rejected by the disambiguator — so those two are gated hard.",
  },

  connectionStatus() {
    const c = credentialStatus();
    return {
      id: "newsapi",
      label: "NewsAPI",
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

    const effectiveDays = Math.min(sinceDays, MAX_HISTORY_DAYS);
    const fromIso = new Date(Date.now() - effectiveDays * 864e5).toISOString().slice(0, 10);
    const candidates = [];
    const gaps = [];
    const stats = { raw: 0, rejected_no_context: 0, rejected_aggregator: 0, passed_unconfirmed: 0, api_errors: [], by_brand: {} };

    if (sinceDays > MAX_HISTORY_DAYS) {
      gaps.push({
        brand_id: null,
        reason:
          `NewsAPI free tier serves only ~${MAX_HISTORY_DAYS} days; the requested ${sinceDays}d window is ` +
          `served from ${fromIso} onward by this source. Older news comes from the RSS feeds instead.`,
      });
    }

    const targets = brands ? allBrands().filter(b => brands.includes(b.id)) : allBrands();

    for (const b of targets) {
      const query = searchTerms(b.id)[0]; // exact-phrase primary alias
      let kept = 0;
      let raw = 0;
      let rejected = 0;
      let total = 0;

      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await fetchPage(query, page, fromIso);
        if (!res.ok) {
          stats.api_errors.push({ brand: b.id, error: res.error });
          gaps.push({ brand_id: b.id, reason: `NewsAPI error: ${res.error}` });
          break;
        }
        total = res.total;
        if (!res.articles.length) break;
        raw += res.articles.length;
        stats.raw += res.articles.length;

        for (const a of res.articles) {
          if (!a.url) continue;

          // Aggregator reposts duplicate the original and add no provenance.
          const dom = domainOf(a.url) || "";
          if (AGGREGATOR.test(dom)) { rejected++; stats.rejected_aggregator++; continue; }

          const text = [a.title, a.description, a.content].filter(Boolean).join(". ");
          const m = matchBrand(text, b.id);

          /* PRE-FILTER, applied ASYMMETRICALLY — and this asymmetry is the point.
           *
           * NewsAPI searches the full article body but returns only a ~200-char
           * `content` snippet plus a one-line description. Measured: all 8
           * Mintlify articles were rejected on the snippet because the brand name
           * sits deeper in the body than NewsAPI reveals. Rejecting on the snippet
           * therefore throws away real mentions.
           *
           * But letting everything through means fetching the ~200 Nepal-flood and
           * concert-listing articles that "Confluence" and "Guru" return, every run.
           *
           * So: for UNAMBIGUOUS product names, pass the article through and let the
           * pipeline's full-page fetch make the call — recall wins, and accuracy is
           * still guaranteed downstream. For AMBIGUOUS names (Confluence, Guru)
           * require snippet confirmation, because the false-positive volume is
           * otherwise ~99% and the fetch cost is real. That trade-off is recorded
           * as a coverage gap rather than left implicit.
           */
          const ambiguous = !!brandCfg(b.id).ambiguous;
          if (!m.present) {
            if (ambiguous) { rejected++; stats.rejected_no_context++; continue; }
            stats.passed_unconfirmed++;
          }

          const type = classifyType(text, null);
          const intent = detectBuyingIntent(text, null);
          const ev = detectEvent(text, null);
          const cmp = detectComparisons(text, b.id);
          const published = toIsoDate(a.publishedAt);

          candidates.push({
            brand_id: b.id,
            channel: ev.is_sponsorship || ev.is_event ? "event" : channelFromSource("news", a.url),
            url: a.url,
            title: a.title || null,
            published_at: published,
            date_method: published ? "newsapi:publishedAt" : null,
            source_text: [a.description, a.content].filter(Boolean).join(" "),
            // NewsAPI asserts the article exists; the pipeline still fetches the
            // URL itself, which is what sets url_verified.
            source_verified: true,
            source_adapter: "newsapi",
            discovered_via: `newsapi /v2/everything?q=${encodeURIComponent(query)}`,
            author: a.author || null,

            api_source: "newsapi",
            // NewsAPI supplies NO sentiment. Left null so Claude classifies it
            // from the evidence excerpt rather than anything being guessed here.
            sentiment: null,
            relevance_score: null,
            // Lower confidence when the snippet did not confirm the brand: the
            // pipeline's page fetch is what will settle it.
            confidence_score: m.present ? (m.context_term ? 0.9 : 0.8) : 0.5,
            mention_type: type.type,
            mention_type_basis: `${type.by}: ${type.matched || type.type}`,
            buying_intent: intent.intent,
            buying_intent_basis: intent.matched,
            comparison_products: cmp,
            is_event: ev.is_event,
            is_sponsorship: ev.is_sponsorship,
            event_basis: ev.matched,
            provider_tags: [],
            extra: {
              newsapi_source_id: (a.source && a.source.id) || null,
              newsapi_source_name: (a.source && a.source.name) || null,
              matched_alias: m.matched_alias || null,
              match_context: m.context_term || null,
              snippet_confirmed: m.present,
            },
          });
          kept++;
        }

        if (raw >= total || raw >= PAGE_SIZE * MAX_PAGES) break;
      }

      stats.by_brand[b.id] = { raw, kept, rejected, totalResults: total };
      log(
        `    ${b.name.padEnd(13)} ${String(kept).padStart(3)} passed of ${String(raw).padStart(3)} fetched` +
          ` (${rejected} rejected here, NewsAPI claimed ${total} total)`
      );

      // A brand whose entire NewsAPI yield was false positives is worth stating.
      if (raw > 0 && kept === 0 && brandCfg(b.id).ambiguous) {
        gaps.push({
          brand_id: b.id,
          reason:
            `All ${raw} NewsAPI article(s) for "${b.name}" failed brand disambiguation — NewsAPI reported ` +
            `${total} totalResults but none were about the product. This is a naming collision, not activity.`,
        });
      }
    }

    return { candidates, gaps, providerStats: stats };
  },
};
