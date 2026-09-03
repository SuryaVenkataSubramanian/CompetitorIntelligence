/**
 * Adapter: LinkedIn via Bright Data Web Scraper API
 *
 * WHY THIS REPLACES GUESSWORK
 * ---------------------------
 * LinkedIn was the weakest channel in this dashboard: the old adapter could see
 * company pages but not the posts that actually mention a product, and five
 * public posts supplied as seeds had all been missed. Bright Data's
 * "LinkedIn posts" dataset (gd_lyy3tktm25m4avu764) returns, per post:
 *
 *   post_text, date_posted (exact), user_name, user_id, use_url (profile),
 *   user_followers, num_likes, num_comments, tagged_companies, hashtags
 *
 * That is every field requirement 4 asks for, all of it provider-verified
 * rather than inferred.
 *
 * THE DISCOVERY CONSTRAINT THAT SHAPES THIS FILE
 * ----------------------------------------------
 * Asked which discovery collectors it supports, the dataset answers:
 *
 *     url, profile_url, company_url        ← no keyword discovery
 *
 * So keyword coverage cannot come from Bright Data directly. It is obtained in
 * two stages: a web search finds linkedin.com/posts URLs for each keyword, and
 * Bright Data then scrapes those URLs for verified content. Four stages in all:
 *
 *   1 SEEDS    the five supplied lnkd.in links, resolved through their redirect
 *   2 SEARCH   SearXNG finds linkedin.com/posts URLs per keyword
 *   3 COMPANY  company_url discovery over all 7 products' company pages
 *   4 PROFILE  profile_url discovery over authors already seen mentioning a product
 *
 * Stage 3 is the volume lever: one company page returned 60 posts in testing.
 *
 * A post is only recorded against a product when matchBrand() confirms the
 * product in the post's own text — the same disambiguation gate every other
 * adapter uses. A keyword that merely surfaced a URL is never sufficient, which
 * is what requirement 4 means by "only when contextual evidence supports it".
 */
const crypto = require("crypto");
const { load } = require("../lib/env");
const { fetchUrl } = require("../lib/fetch");
const bd = require("../lib/brightdata");
const { allBrands, brandOrder, matchBrand, brand } = require("../lib/brands");
const {
  classifyType, detectBuyingIntent, detectComparisons, detectEvent,
} = require("../lib/classify");
const { toIsoDate } = require("../lib/verify");
const searx = require("../lib/searxng-client");

load();

/** The five public posts supplied as known-missed examples. */
const SEED_URLS = [
  "https://lnkd.in/p/gW9w6Qbs",
  "https://lnkd.in/p/gVrkvGt5",
  "https://lnkd.in/p/gPuaRYbu",
  "https://lnkd.in/p/ggPhSiRG",
  "https://lnkd.in/p/g9sAEa5y",
];

/**
 * Keywords to discover beyond the seeds. The first group is explicit product
 * naming; the second is category discussion where Document360 may appear
 * WITHOUT the product keyword — requirement 4 asks for both, and only the
 * brand matcher decides whether a category post actually mentions a product.
 */
const PRODUCT_KEYWORDS = [
  "Document360",
  '"Document 360"',
  "Document360 AI",
  "Document360 documentation",
  "Document360 knowledge base",
  "Document360 video to documentation",
  "Document360 API documentation",
  "Document360 alternatives",
  "Document360 vs",
];

const CATEGORY_KEYWORDS = [
  "knowledge base software",
  "documentation platform",
  "AI documentation tool",
  "help center software",
  "technical writing tool",
  "API documentation platform",
  "video to documentation",
  "SOP documentation software",
];

const LI_POST_URL = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(posts|feed\/update)\//i;

/* ------------------------------------------------------------------ helpers */

function credentialStatus() {
  if (!bd.configured()) {
    return {
      ok: false,
      reason: "BRIGHTDATA_API_KEY not set — LinkedIn post scraping is not connected.",
      how_to_enable: "Add BRIGHTDATA_API_KEY to .env, then run: npm run collect:linkedin",
    };
  }
  return { ok: true, reason: null };
}

/**
 * A LinkedIn post is reachable under several different URLs for the same
 * content: the lnkd.in shortlink, a `…-share-<id>-…` form, and the canonical
 * `…-activity-<id>-…` form Bright Data returns. Those ids differ, so a
 * URL-equality dedup would count one post up to three times.
 *
 * The stable identity is therefore the author plus the post's own opening text.
 */
function linkedinKey(row) {
  const author = String(row.user_id || row.user_name || "").toLowerCase().trim();
  const text = String(row.post_text || row.headline || "")
    .toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160);
  if (!text) return null;
  return crypto.createHash("sha1").update(author + "|" + text).digest("hex");
}

/** Resolve a shortlink (or any URL) to where it actually lands. */
async function resolveRedirect(url) {
  const r = await fetchUrl(url, { retries: 1, timeout: 25000, maxRedirects: 6 });
  if (!r.ok) return { ok: false, url, status: r.status, error: r.error };
  // Strip the share/tracking query so the stored URL is clean but still valid.
  let clean = r.final_url;
  try {
    const u = new URL(r.final_url);
    u.search = "";
    clean = u.toString().replace(/\/$/, "");
  } catch (e) { /* keep as-is */ }
  return { ok: true, url: clean, original: url, status: r.status };
}

/**
 * Find linkedin.com/posts URLs for a query. LinkedIn is aggressively
 * de-indexed by some engines, so a miss here is a coverage gap rather than
 * proof that no post exists — reported as such.
 */
async function searchPostUrls(query, { days = 365 } = {}) {
  const found = new Set();
  let error = null;
  try {
    const r = await searx.search(`site:linkedin.com/posts ${query}`, { days, categories: "general" });
    for (const item of (r && r.results) || []) {
      const u = String(item.url || "");
      if (LI_POST_URL.test(u)) {
        try {
          const parsed = new URL(u);
          parsed.search = "";
          found.add(parsed.toString().replace(/\/$/, ""));
        } catch (e) { /* skip malformed */ }
      }
    }
  } catch (e) {
    error = String(e.message || e);
  }
  return { urls: [...found], error };
}

/**
 * Which tracked products does this post genuinely mention?
 * Judged on the post's own text through the disambiguating matcher, never on
 * the keyword that surfaced it.
 */
function resolveProducts(row, matchedKeyword) {
  const text = [row.post_text, row.headline, row.title].filter(Boolean).join("\n");
  const out = [];
  for (const id of brandOrder()) {
    const m = matchBrand(text, id);
    if (!m.present) continue;

    // A tagged company is independent corroboration from LinkedIn's own entity
    // graph, so it raises confidence above a text match alone.
    const tagged = (row.tagged_companies || []).some(t =>
      brand(id).aliases.some(a => String(t.name || "").toLowerCase().includes(a.toLowerCase()))
    );
    out.push({
      id,
      match: m,
      tagged_company: tagged,
      confidence: tagged ? 0.98 : 0.9,
      matched_keyword: matchedKeyword || null,
    });
  }
  return out;
}

/** Turn one Bright Data row into candidate records, one per matched product. */
function toCandidates(row, { stage, matchedKeyword, brands }) {
  const text = [row.post_text, row.headline].filter(Boolean).join("\n");
  if (!text.trim()) return [];

  const products = resolveProducts(row, matchedKeyword);
  if (!products.length) return [];

  const published = toIsoDate(row.date_posted);
  const out = [];

  for (const p of products) {
    if (brands && !brands.includes(p.id)) continue;

    const type = classifyType(text, row.hashtags || []);
    const intent = detectBuyingIntent(text, row.hashtags || []);
    const ev = detectEvent(text, row.hashtags || []);
    const cmp = detectComparisons(text, p.id);

    out.push({
      brand_id: p.id,
      channel: ev.is_sponsorship || ev.is_event ? "event" : "linkedin",
      url: row.url,
      title: row.title || row.headline || null,
      published_at: published,
      date_method: published ? "brightdata:date_posted" : null,

      // Bright Data fetched and returned this text; it is the post itself, so it
      // is legitimate evidence attributed to Bright Data rather than inferred.
      source_text: row.post_text || row.headline || null,
      source_verified: true,
      source_adapter: "linkedin_brightdata",
      discovered_via: `brightdata ${bd.DATASETS.linkedin_posts.id} (${stage})`,
      author: row.user_name || row.user_id || null,

      api_source: "brightdata",
      // No sentiment: Bright Data does not supply one and this adapter will not
      // invent one. It is left null for the Claude classification pass.
      sentiment: null,
      sentiment_method: null,
      confidence_score: p.confidence,
      mention_type: type.type,
      mention_type_basis: `${type.by}: ${type.matched || type.type}`,
      buying_intent: intent.intent,
      buying_intent_basis: intent.matched,
      comparison_products: cmp,
      is_event: ev.is_event,
      is_sponsorship: ev.is_sponsorship,
      event_basis: ev.matched,
      provider_tags: row.hashtags || [],

      engagement: {
        likes: row.num_likes ?? null,
        comments: row.num_comments ?? null,
        author_followers: row.user_followers ?? null,
      },

      extra: {
        linkedin_post_id: row.id || null,
        linkedin_key: linkedinKey(row),
        author_profile: row.use_url || null,
        author_handle: row.user_id || null,
        account_type: row.account_type || null,
        post_type: row.post_type || null,
        tagged_companies: (row.tagged_companies || []).map(t => t.name).filter(Boolean),
        matched_keyword: matchedKeyword || null,
        discovery_stage: stage,
        brand_match_basis: p.match.matched || null,
        tagged_company_corroboration: p.tagged_company,
      },
    });
  }
  return out;
}

/* -------------------------------------------------------------------- stages */

// One snapshot per 50 URLs. A single 200-URL snapshot is a multi-megabyte
// download and an all-or-nothing failure; chunking means one bad batch costs
// one batch. Partial success is also genuinely useful here, so it is kept.
const BATCH = 50;

/** Scrape an explicit list of post URLs, in batches. */
async function scrapeUrls(urls, { stage, matchedKeyword = null, brands, log }) {
  if (!urls.length) return { candidates: [], rows: 0, error: null };

  const candidates = [];
  const snapshots = [];
  const errors = [];
  let rowCount = 0;

  for (let i = 0; i < urls.length; i += BATCH) {
    const chunk = urls.slice(i, i + BATCH);
    const n = Math.floor(i / BATCH) + 1;
    const total = Math.ceil(urls.length / BATCH);
    const res = await bd.collect(
      bd.DATASETS.linkedin_posts.id,
      chunk.map(u => ({ url: u })),
      { maxMs: 12 * 60 * 1000 }
    );
    if (!res.ok) {
      log(`      ${stage} batch ${n}/${total}: FAILED (${res.status}) ${String(res.error || "").slice(0, 120)}`);
      errors.push(`batch ${n}: ${res.status} ${res.error}`);
      continue;
    }
    const { posts, errors } = partitionRows(res.rows);
    rowCount += posts.length;
    for (const r of posts) candidates.push(...toCandidates(r, { stage, matchedKeyword, brands }));
    snapshots.push(res.snapshot_id);
    log(`      ${stage} batch ${n}/${total}: ${posts.length}/${chunk.length} post(s)` +
      `${errors.length ? `, ${errors.length} error row(s)` : ""}` +
      `${res.truncated ? " [download truncated]" : ""} → ${candidates.length} mention(s) so far`);
  }

  return {
    candidates,
    rows: rowCount,
    error: errors.length ? errors.join("; ") : null,
    snapshot_id: snapshots[0] || null,
    snapshot_ids: snapshots,
  };
}

/**
 * Split a snapshot into usable posts and Bright Data's own error rows.
 *
 * `include_errors=true` means the snapshot interleaves failures with successes.
 * Filtering them out silently made a stage that returned 486 rows — 463 of them
 * good — log "0 post(s)" with no indication why, so the counts are reported.
 */
function partitionRows(rows) {
  const posts = [];
  const errors = [];
  for (const r of rows || []) {
    if (!r) continue;
    if (r.error || r.error_code) {
      errors.push({ error: r.error || r.error_code, input: (r.input && r.input.url) || null });
    } else if (r.post_text || r.headline) {
      posts.push(r);
    } else {
      errors.push({ error: "row had neither post_text nor an error field", input: (r.input && r.input.url) || null });
    }
  }
  return { posts, errors };
}

function summariseErrors(errors) {
  const by = {};
  for (const e of errors) {
    const k = String(e.error).slice(0, 60);
    by[k] = (by[k] || 0) + 1;
  }
  return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}x ${k}`);
}

/**
 * Discover posts from a company or profile page.
 *
 * Company discovery over seven company pages legitimately runs six to eight
 * minutes and returns hundreds of posts, so the budget is generous. A timeout
 * returns the failure rather than a partial set presented as complete.
 */
async function discoverFrom(inputs, discoverBy, { stage, brands, log }) {
  if (!inputs.length) return { candidates: [], rows: 0, error: null };
  const res = await bd.collect(bd.DATASETS.linkedin_posts.id, inputs, {
    discoverBy,
    maxMs: 20 * 60 * 1000,
    onTick: t => { if (t && t.status === "running") log(`      ${stage}: collecting…`); },
  });
  if (!res.ok) {
    log(`      ${stage}: FAILED (${res.status}) ${String(res.error || "").slice(0, 140)}`);
    return { candidates: [], rows: 0, error: `${res.status}: ${res.error}`, snapshot_id: res.snapshot_id || null };
  }

  const { posts, errors } = partitionRows(res.rows);
  const candidates = [];
  for (const r of posts) candidates.push(...toCandidates(r, { stage, brands }));

  log(`      ${stage}: ${posts.length} post(s) discovered` +
    `${errors.length ? `, ${errors.length} provider error row(s)` : ""}` +
    ` → ${candidates.length} product mention(s)`);
  if (errors.length) log(`        provider errors: ${summariseErrors(errors).slice(0, 3).join("; ")}`);

  return {
    candidates,
    rows: posts.length,
    provider_errors: errors.length,
    provider_error_summary: summariseErrors(errors).slice(0, 5),
    error: null,
    snapshot_id: res.snapshot_id,
  };
}

/* -------------------------------------------------------------------- export */

module.exports = {
  id: "linkedin_brightdata",
  label: "LinkedIn (Bright Data Web Scraper)",
  channel: "linkedin",
  requires: ["BRIGHTDATA_API_KEY"],
  credentialStatus,
  available() { return credentialStatus(); },

  SEED_URLS,
  PRODUCT_KEYWORDS,
  CATEGORY_KEYWORDS,
  linkedinKey,
  resolveRedirect,

  coverageLimit: {
    note:
      "The Bright Data LinkedIn-posts dataset supports discovery by url, profile_url " +
      "and company_url only — there is no keyword discovery. Keyword coverage is " +
      "therefore bounded by how many linkedin.com/posts URLs a web search can surface, " +
      "and LinkedIn is partially de-indexed. A keyword returning no URLs means " +
      "'not found by search', not 'no such post exists'.",
    discovery_modes: bd.DATASETS.linkedin_posts.discover,
  },

  connectionStatus() {
    const c = credentialStatus();
    return {
      id: "linkedin_brightdata",
      label: "LinkedIn (Bright Data Web Scraper)",
      connected: c.ok,
      blockers: c.ok ? [] : [c.reason],
      how_to_enable: c.how_to_enable || null,
      fallback_in_use: null,
    };
  },

  async collect({
    sinceDays = 365,
    brands = null,
    log = () => {},
    stages = ["seeds", "search", "company", "profile"],
    maxSearchKeywords = 12,
  } = {}) {
    const cred = credentialStatus();
    if (!cred.ok) {
      log(`    dormant: ${cred.reason}`);
      return { candidates: [], gaps: [{ brand_id: null, reason: cred.reason }], unavailable: true };
    }

    const candidates = [];
    const gaps = [];
    const stats = {
      stages: {},
      seeds_resolved: 0,
      seed_failures: [],
      search_urls_found: 0,
      keywords_with_no_results: [],
      snapshots: [],
      rows_scraped: 0,
      dedup_dropped: 0,
    };

    // Dedup inside this run. The cross-source dedup against Octolens/NewsAPI is
    // handled downstream by lib/dedupe.js; this only stops the four stages from
    // re-reporting the same post to each other.
    const seen = new Set();
    const add = list => {
      for (const c of list) {
        const k = (c.extra && c.extra.linkedin_key) || c.url;
        if (seen.has(k + "|" + c.brand_id)) { stats.dedup_dropped++; continue; }
        seen.add(k + "|" + c.brand_id);
        candidates.push(c);
      }
    };

    /* ------------------------------------------------------------- 1 seeds */
    if (stages.includes("seeds")) {
      log("    stage 1/4 seeds — resolving the supplied lnkd.in links");
      const resolved = [];
      for (const s of SEED_URLS) {
        const r = await resolveRedirect(s);
        if (r.ok && LI_POST_URL.test(r.url)) {
          resolved.push(r.url);
          log(`      ${s} → ${r.url.slice(0, 96)}`);
        } else {
          stats.seed_failures.push({ url: s, status: r.status, error: r.error || "not a post URL" });
          log(`      ${s} → UNRESOLVED (${r.status || r.error})`);
        }
      }
      stats.seeds_resolved = resolved.length;
      const out = await scrapeUrls(resolved, { stage: "seeds", brands, log });
      add(out.candidates);
      stats.rows_scraped += out.rows;
      stats.stages.seeds = { urls: resolved.length, rows: out.rows, candidates: out.candidates.length, error: out.error };
      if (out.snapshot_id) stats.snapshots.push({ stage: "seeds", snapshot_id: out.snapshot_id });
    }

    /* ------------------------------------------------------------ 2 search */
    if (stages.includes("search")) {
      log("    stage 2/4 search — finding post URLs per keyword");
      const queries = [...PRODUCT_KEYWORDS, ...CATEGORY_KEYWORDS].slice(0, maxSearchKeywords);
      const urlToKeyword = new Map();
      for (const q of queries) {
        const { urls, error } = await searchPostUrls(q, { days: sinceDays });
        if (error) log(`      search "${q}" errored: ${error}`);
        if (!urls.length) {
          stats.keywords_with_no_results.push(q);
        } else {
          log(`      "${q}" → ${urls.length} post URL(s)`);
        }
        for (const u of urls) if (!urlToKeyword.has(u)) urlToKeyword.set(u, q);
      }
      stats.search_urls_found = urlToKeyword.size;

      // Batch the scrape: one Bright Data collection for all discovered URLs is
      // far cheaper than one per keyword.
      const urls = [...urlToKeyword.keys()];
      if (urls.length) {
        const out = await scrapeUrls(urls, { stage: "search", brands, log });
        // Re-attach the keyword that found each URL.
        for (const c of out.candidates) {
          const kw = urlToKeyword.get(c.url) ||
            [...urlToKeyword.entries()].find(([u]) => c.url && c.url.includes(u.split("/").pop()))?.[1] || null;
          if (kw) { c.extra.matched_keyword = kw; }
        }
        add(out.candidates);
        stats.rows_scraped += out.rows;
        stats.stages.search = { urls: urls.length, rows: out.rows, candidates: out.candidates.length, error: out.error };
        if (out.snapshot_id) stats.snapshots.push({ stage: "search", snapshot_id: out.snapshot_id });
      } else {
        stats.stages.search = { urls: 0, rows: 0, candidates: 0, error: "no linkedin.com/posts URLs surfaced by search" };
      }
    }

    /* ----------------------------------------------------------- 3 company */
    if (stages.includes("company")) {
      log("    stage 3/4 company — discovering posts from each product's company page");
      const inputs = [];
      for (const b of allBrands()) {
        if (brands && !brands.includes(b.id)) continue;
        if (!b.linkedin_slug) {
          gaps.push({ brand_id: b.id, reason: "No linkedin_slug in config/brands.json — company discovery skipped." });
          continue;
        }
        inputs.push({ url: `https://www.linkedin.com/company/${b.linkedin_slug}/` });
      }
      const out = await discoverFrom(inputs, "company_url", { stage: "company", brands, log });
      add(out.candidates);
      stats.rows_scraped += out.rows;
      stats.stages.company = { inputs: inputs.length, rows: out.rows, candidates: out.candidates.length, error: out.error };
      if (out.snapshot_id) stats.snapshots.push({ stage: "company", snapshot_id: out.snapshot_id });
    }

    /* ----------------------------------------------------------- 4 profile */
    if (stages.includes("profile")) {
      // Authors already seen mentioning a tracked product are the highest-yield
      // profiles to sweep: someone who posted about Document360 once often does
      // so repeatedly. Bounded to keep the collection affordable.
      const authors = [...new Set(
        candidates
          .filter(c => c.brand_id === "document360" && c.extra && c.extra.author_profile)
          .map(c => String(c.extra.author_profile).split("?")[0])
      )].slice(0, 10);

      if (authors.length) {
        log(`    stage 4/4 profile — sweeping ${authors.length} author profile(s) that mentioned Document360`);
        const out = await discoverFrom(authors.map(u => ({ url: u })), "profile_url", { stage: "profile", brands, log });
        add(out.candidates);
        stats.rows_scraped += out.rows;
        stats.stages.profile = { inputs: authors.length, rows: out.rows, candidates: out.candidates.length, error: out.error };
        if (out.snapshot_id) stats.snapshots.push({ stage: "profile", snapshot_id: out.snapshot_id });
      } else {
        log("    stage 4/4 profile — skipped: no author profiles found in earlier stages");
        stats.stages.profile = { inputs: 0, rows: 0, candidates: 0, error: "no author profiles available" };
      }
    }

    /* ------------------------------------------------------------- window */
    // Apply the date window last, so the log can distinguish "not found" from
    // "found but older than the window".
    const cutoff = new Date(Date.now() - sinceDays * 864e5);
    const inWindow = candidates.filter(c => {
      if (!c.published_at) return true; // undated is handled downstream, never dropped silently
      return new Date(c.published_at) >= cutoff;
    });
    stats.out_of_window = candidates.length - inWindow.length;

    /* ------------------------------------------------------- coverage gaps */
    const covered = new Set(inWindow.map(c => c.brand_id));
    for (const b of allBrands()) {
      if (covered.has(b.id)) continue;
      gaps.push({
        brand_id: b.id,
        reason:
          `No LinkedIn post mentioning ${b.name} was found by any of the four discovery stages ` +
          `within ${sinceDays} days. Because the dataset has no keyword discovery, this means ` +
          `"not surfaced by company/profile/search discovery" rather than a measured zero.`,
      });
    }
    if (stats.keywords_with_no_results.length) {
      gaps.push({
        brand_id: null,
        reason:
          `${stats.keywords_with_no_results.length} keyword(s) returned no linkedin.com/posts URLs from web ` +
          `search: ${stats.keywords_with_no_results.slice(0, 6).join("; ")}. LinkedIn is partially de-indexed, ` +
          `so these are search-coverage gaps, not evidence of absence.`,
      });
    }

    log(`    ${inWindow.length} candidate(s) from ${stats.rows_scraped} scraped post(s)` +
      `${stats.dedup_dropped ? `, ${stats.dedup_dropped} in-run duplicate(s) dropped` : ""}` +
      `${stats.out_of_window ? `, ${stats.out_of_window} outside the ${sinceDays}d window` : ""}`);

    return { candidates: inWindow, gaps, providerStats: stats };
  },
};
