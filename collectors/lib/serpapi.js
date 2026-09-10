/**
 * SerpAPI client — real Google SERP over plain HTTP.
 *
 * WHY THIS MATTERS FOR THE DEPLOYMENT, NOT JUST FOR COVERAGE
 * ---------------------------------------------------------
 * Everything that needed web search went through SearXNG, which is a LOCAL
 * process. A serverless host cannot reach localhost, so on Vercel those
 * channels were structurally dead — and locally they died whenever the process
 * stopped, which is exactly what had happened: 10 days of silence from Events,
 * SERP and Google-News resolution.
 *
 * SerpAPI is a hosted HTTP API, so it works identically on a laptop and in a
 * function. That is the difference between a channel that works where the app
 * actually runs and one that only works on the machine that built it.
 *
 * PROBED 2026-09-10 (npm run probe:providers):
 *   plan            Free Plan, 250 searches/month
 *   site: operator  WORKS — `site:linkedin.com/posts Document360` returned 10
 *   shape           organic_results[] with link, title, snippet, position, date
 *
 * THE QUOTA IS THE WHOLE DESIGN CONSTRAINT
 * ----------------------------------------
 * 250 searches a month is roughly 8 a day. A full keyword sweep is hundreds of
 * queries, so this cannot be the discovery engine — it would be exhausted in
 * one run and then every dependent channel would report nothing.
 *
 * So: results are cached hard, spend is tracked and capped, and SearXNG stays
 * ahead of it for bulk work when reachable. SerpAPI is the provider that always
 * works, used sparingly; SearXNG is the free one used in volume when it is up.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { fetchJson } = require("./fetch");

const BASE = "https://serpapi.com";
const STORE = path.join(__dirname, "..", "store");
const CACHE_FILE = path.join(STORE, "serpapi-cache.json");
const SPEND_FILE = path.join(STORE, "serpapi-spend.json");

/** A SERP result is stable enough that a day-old answer is fine, and a search
 *  saved is a search available later in the month. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function key() {
  return process.env.SERPAPI_KEY || "";
}
function configured() {
  return !!key();
}

function credentialStatus() {
  if (!configured()) {
    return {
      ok: false,
      reason: "SERPAPI_KEY is not set — SerpAPI is not connected.",
      how_to_enable: "Add SERPAPI_KEY to .env, then run: npm run probe:providers",
    };
  }
  return { ok: true, reason: null };
}

/* -------------------------------------------------------------------- cache */

function readJsonSafe(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return fallback; }
}
function writeJsonSafe(f, obj) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(obj, null, 2));
  } catch (e) { /* a cache is an optimisation, never a dependency */ }
}

function cacheKey(parts) {
  return crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 20);
}

/* -------------------------------------------------------------------- spend */

/** Searches consumed, so an exhausted quota is visible before it bites. */
function readSpend() {
  return readJsonSafe(SPEND_FILE, { searches: 0, by_day: {}, recent: [] });
}

function recordSearch(query, meta = {}) {
  const s = readSpend();
  const day = new Date().toISOString().slice(0, 10);
  s.searches++;
  s.by_day[day] = (s.by_day[day] || 0) + 1;
  s.recent = [{ at: new Date().toISOString(), query: String(query).slice(0, 100), ...meta }, ...(s.recent || [])].slice(0, 200);
  writeJsonSafe(SPEND_FILE, s);
  return s;
}

/** Live plan state. Free to call. */
async function account() {
  if (!configured()) return { ok: false, reason: credentialStatus().reason };
  const r = await fetchJson(`${BASE}/account?api_key=${key()}`, { retries: 1, timeout: 30000 });
  if (!r.ok || !r.json) return { ok: false, status: r.status, reason: `HTTP ${r.status}` };
  const a = r.json;
  return {
    ok: true,
    plan: a.plan_name || null,
    searches_left: a.total_searches_left ?? a.plan_searches_left ?? null,
    searches_used_this_month: a.this_month_usage ?? null,
    checked_at: new Date().toISOString(),
  };
}

/**
 * Refuse a search that would run the quota to zero.
 *
 * `SERPAPI_MIN_REMAINING` keeps a reserve so an automated sweep cannot leave
 * nothing for an interactive query later in the month. A blocked search
 * returns { skipped: "quota" }, which callers must render as "not checked" —
 * never as an empty result set.
 */
async function checkQuota() {
  const reserve = Number(process.env.SERPAPI_MIN_REMAINING || 20);
  const a = await account();
  if (!a.ok) return { allowed: false, reason: `Could not read the SerpAPI quota: ${a.reason}` };
  if (a.searches_left != null && a.searches_left <= reserve) {
    return {
      allowed: false,
      searches_left: a.searches_left,
      reason:
        `Skipped: ${a.searches_left} SerpAPI search(es) remain and the reserve is ${reserve}. ` +
        `This is a quota stop, NOT a measurement of absence. Raise SERPAPI_MIN_REMAINING or ` +
        `upgrade the plan to continue.`,
    };
  }
  return { allowed: true, searches_left: a.searches_left };
}

/**
 * Run one Google search.
 *
 * Returns the same shape as the SearXNG client so serp-provider can swap
 * between them without callers knowing which one answered.
 */
async function search(query, {
  num = 20,
  useCache = true,
  location = null,
  log = () => {},
} = {}) {
  const cred = credentialStatus();
  if (!cred.ok) return { ok: false, results: [], error: cred.reason, skipped: "not_configured" };

  const ck = cacheKey(["serpapi", query, num, location]);
  if (useCache) {
    const c = readJsonSafe(CACHE_FILE, { entries: {} });
    const hit = c.entries[ck];
    if (hit && Date.now() - new Date(hit.cached_at).getTime() < CACHE_TTL_MS) {
      log(`      serpapi: cache hit (${hit.results.length} results) — 0 searches used`);
      return { ok: true, status: 200, results: hit.results, from_cache: true, unresponsive_engines: [] };
    }
  }

  const quota = await checkQuota();
  if (!quota.allowed) {
    log(`      serpapi: SKIPPED — ${String(quota.reason).slice(0, 80)}`);
    return { ok: false, results: [], error: quota.reason, skipped: "quota" };
  }

  const params = new URLSearchParams({
    engine: "google",
    q: query,
    num: String(num),
    api_key: key(),
  });
  if (location) params.set("location", location);

  const r = await fetchJson(`${BASE}/search?${params}`, {
    retries: 1, timeout: 60000, maxBytes: 16 * 1024 * 1024,
  });

  if (!r.ok || !r.json) {
    return { ok: false, results: [], status: r.status, error: `SerpAPI HTTP ${r.status}` };
  }
  // SerpAPI reports failures inside a 200 body, so the JSON must be checked.
  if (r.json.error) {
    return { ok: false, results: [], error: `SerpAPI: ${r.json.error}` };
  }

  recordSearch(query, { results: (r.json.organic_results || []).length });

  const results = (r.json.organic_results || []).map(x => {
    let domain = null;
    try { domain = new URL(x.link).hostname.replace(/^www\./, ""); } catch (e) { /* keep null */ }
    return {
      rank: x.position ?? null,
      url: x.link,
      title: x.title || null,
      content: x.snippet || "",
      domain,
      engine: "google",
      // SerpAPI surfaces a displayed date for some results. Kept as a hint
      // only: the pipeline still proves a date from the page itself.
      date_hint: x.date || null,
    };
  });

  const c = readJsonSafe(CACHE_FILE, { entries: {} });
  c.entries[ck] = { results, cached_at: new Date().toISOString() };
  // Bound the cache.
  const keys = Object.keys(c.entries);
  if (keys.length > 600) {
    keys.map(k => [k, c.entries[k].cached_at])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
      .slice(0, keys.length - 600)
      .forEach(([k]) => delete c.entries[k]);
  }
  writeJsonSafe(CACHE_FILE, c);

  log(`      serpapi: ${results.length} result(s), ${quota.searches_left - 1} search(es) left`);
  return { ok: true, status: 200, results, from_cache: false, unresponsive_engines: [] };
}

/** Health probe, matching the SearXNG client's contract. */
async function probe() {
  const cred = credentialStatus();
  if (!cred.ok) return { ok: false, reason: cred.reason };
  const a = await account();
  if (!a.ok) return { ok: false, reason: `SerpAPI account check failed: ${a.reason}` };
  if (a.searches_left === 0) {
    return { ok: false, reason: `SerpAPI quota exhausted (plan ${a.plan}). This is a quota stop, not an absence of results.` };
  }
  return {
    ok: true,
    reason: null,
    detail: `SerpAPI (${a.plan}) — ${a.searches_left} search(es) left this month`,
    searches_left: a.searches_left,
    plan: a.plan,
  };
}

module.exports = { BASE, configured, credentialStatus, account, checkQuota, search, probe, readSpend, CACHE_FILE };
