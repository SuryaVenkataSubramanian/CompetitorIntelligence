/**
 * SearXNG HTTP client.
 *
 * Extracted from adapters/searxng.js so the provider layer can depend on the
 * client without the adapter depending back on the provider (which would be a
 * circular import). The adapter now consumes lib/serp-provider like every other
 * caller, so if SearXNG dies mid-run the collection degrades instead of zeroing.
 *
 * Set SEARXNG_URL (default http://localhost:8888). Both `localhost` and
 * `127.0.0.1` were verified to work against the local instance, so IPv6
 * resolution is not a trap here.
 */
const { fetchJson, fetchUrl } = require("./fetch");

const BASE = (process.env.SEARXNG_URL || "http://localhost:8888").replace(/\/$/, "");

/** SearXNG time_range accepts day | month | year (there is no "week"). */
function timeRange(days) {
  if (days <= 1) return "day";
  if (days <= 31) return "month";
  return "year";
}

async function search(query, { days = 90, categories = "general", pageno = 1, engines = null } = {}) {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    categories,
    pageno: String(pageno),
    safesearch: "0",
    language: "en",
  });
  // Only constrain time when the caller asked for a narrow window; a year-wide
  // filter is what SearXNG defaults to anyway and some engines drop results.
  if (days <= 31) params.set("time_range", timeRange(days));
  if (engines) params.set("engines", engines);

  const url = `${BASE}/search?${params.toString()}`;
  const r = await fetchJson(url, { timeout: 45000, retries: 1 });

  if (!r.ok) return { ok: false, status: r.status, results: [], url, error: r.error || `HTTP ${r.status}` };
  if (!r.json) {
    // The single most common misconfiguration.
    return {
      ok: false,
      status: r.status,
      results: [],
      url,
      error: "instance returned non-JSON — enable `formats: [html, json]` under `search:` in settings",
    };
  }
  return {
    ok: true,
    status: r.status,
    results: r.json.results || [],
    url,
    unresponsive_engines: r.json.unresponsive_engines || [],
  };
}

/** Probe reachability AND that the JSON API is actually enabled. */
async function probe() {
  const r = await fetchUrl(`${BASE}/`, { timeout: 10000, retries: 0 });
  if (!r.ok) {
    return {
      ok: false,
      reason:
        `no SearXNG instance at ${BASE} (HTTP ${r.status || "no response"}). ` +
        `Start one: npm run searxng:local  (or npm run searxng:up for Docker)`,
    };
  }
  const s = await search("knowledge base software", { days: 365 });
  if (!s.ok) return { ok: false, reason: `SearXNG at ${BASE} is reachable but search failed: ${s.error}` };
  return {
    ok: true,
    reason: null,
    detail:
      `SearXNG at ${BASE} — ${s.results.length} results, engines: ` +
      ([...new Set(s.results.map(x => x.engine))].join(", ") || "none") +
      (s.unresponsive_engines.length
        ? `; unresponsive: ${s.unresponsive_engines.map(e => Array.isArray(e) ? e.join(" ") : e).join(", ")}`
        : ""),
    unresponsive: s.unresponsive_engines,
  };
}

module.exports = { search, probe, BASE };
