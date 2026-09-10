/**
 * SERP provider selection.
 *
 * Everything that needs web search (the Events channel, the Web/AI-Overview
 * column, Google News link resolution, blog discovery for brands with no RSS
 * feed) goes through here rather than importing an engine directly.
 *
 * Order of preference:
 *   1. SearXNG at SEARXNG_URL — preferred when reachable. It aggregates 6+
 *      engines behind a maintained parser, so recall is better and markup drift
 *      is somebody else's problem.
 *   2. Built-in Node metasearch (lib/serp.js) — zero install. Needs neither
 *      Docker nor Python, which is the only option on a machine without either
 *      and without local admin.
 *
 * SERP_PROVIDER=searxng|builtin|auto  (default: auto)
 *
 * Which provider actually served a run is recorded and surfaced in the dashboard,
 * because the two have materially different recall and a business user reading a
 * competitor count should know which one produced it.
 */
// Depends on the CLIENT, not the adapter, so adapters/searxng.js can consume this
// provider without a circular import.
const searxng = require("./searxng-client");
const builtin = require("./serp");
const dfs = require("./dataforseo");
const serpapi = require("./serpapi");

const MODE = (process.env.SERP_PROVIDER || "auto").toLowerCase();

let resolved = null; // cached for the life of the process

async function resolve({ log = () => {} } = {}) {
  if (resolved) return resolved;

  /* DATAFORSEO FIRST.
   *
   * SearXNG was the preferred provider and it is not a reliable one: it is a
   * local process that has to be running, its upstream engines rate-limit and
   * CAPTCHA independently, and when it stops the channels that depend on it go
   * quiet rather than erroring. Measured: unreachable, and the Events, SERP and
   * Google-News channels had been stale for 10 days as a result.
   *
   * DataForSEO returns real Google results over plain HTTP with no local
   * service, so nothing to keep alive. It costs $0.002 a query, which is the
   * trade: a metered provider that works beats a free one that is down.
   * SearXNG remains the free fallback for exactly that reason. */
  const wantDfs = MODE === "dataforseo" || MODE === "auto";
  if (wantDfs && dfs.configured()) {
    const bal = await dfs.balance();
    const minBal = Number(process.env.DATAFORSEO_MIN_BALANCE || 0.05);
    /* Enough headroom for at least one QUERY, not merely above the reserve.
     *
     * Measured bug: with a balance of $0.0519 and a $0.05 reserve, `> minBal`
     * was true, so DataForSEO was selected over a working free provider — and
     * then every query it served failed the budget guard, because a Google
     * organic call costs $0.002-0.004. Selecting a provider that cannot answer
     * is worse than not selecting it. */
    const perQuery = 0.004;
    if (bal.ok && bal.balance - minBal >= perQuery) {
      resolved = {
        id: "dataforseo",
        label: "DataForSEO (real Google SERP)",
        search: async (q, o = {}) => {
          const r = await dfs.googleOrganic(q, { useCache: o.useCache !== false, log: o.log });
          if (!r.ok) return { ok: false, results: [], error: r.error, status: r.status };
          return {
            ok: true,
            status: 200,
            results: r.results,
            unresponsive_engines: [],
            cost: r.cost || 0,
            from_cache: !!r.from_cache,
          };
        },
        note:
          `Real Google results via DataForSEO. Balance ${Number(bal.balance).toFixed(4)} at ~` +
          `$0.002/query (~${Math.floor((bal.balance - minBal) / 0.002)} queries). Cached for 7 days, ` +
          `so a repeated query is free.`,
        degraded: false,
        metered: true,
        balance: bal.balance,
        capabilities: {
          provider: "dataforseo",
          site_operator: true,
          qualifier_terms: true,
          date_filter: false,   // depth/location, not a time_range parameter
          serves_channels: ["web", "blog", "linkedin", "x", "video", "event"],
          cannot_serve_channels: [],
        },
      };
      log(`    SERP provider: DataForSEO (real Google), balance ${Number(bal.balance).toFixed(4)}`);
      return resolved;
    }
    if (bal.ok) {
      log(`    DataForSEO balance ${Number(bal.balance).toFixed(4)} is at or below the ${minBal} reserve — falling back`);
    } else {
      log(`    DataForSEO unavailable (${String(bal.reason).slice(0, 60)}) — falling back`);
    }
    if (MODE === "dataforseo") {
      resolved = {
        id: "none", label: "none",
        search: async () => ({ ok: false, results: [], error: "DataForSEO was requested but is unavailable or out of budget" }),
        note: "SERP_PROVIDER=dataforseo was requested but the balance is exhausted or the credential failed.",
        unavailable: true, degraded: true,
      };
      return resolved;
    }
  }

  const wantSearx = MODE === "searxng" || MODE === "auto";
  const wantBuiltin = MODE === "builtin" || MODE === "auto";

  if (wantSearx) {
    const p = await searxng.probe();
    if (p.ok) {
      resolved = {
        id: "searxng",
        label: "SearXNG (self-hosted metasearch)",
        search: (q, o) => searxng.search(q, o),
        note: p.detail || `SearXNG at ${searxng.BASE}`,
        degraded: false,
        capabilities: {
          provider: "searxng",
          site_operator: true,
          qualifier_terms: true,
          date_filter: true,
          serves_channels: ["web", "blog", "linkedin", "x", "video", "event"],
          cannot_serve_channels: [],
        },
      };
      log(`    SERP provider: ${p.detail}`);
      return resolved;
    }
    if (MODE === "searxng") {
      resolved = {
        id: "none",
        label: "none",
        search: async () => ({ ok: false, results: [], error: p.reason }),
        note: `SERP_PROVIDER=searxng was requested but ${p.reason}`,
        unavailable: true,
        degraded: true,
      };
      log(`    SERP provider: UNAVAILABLE — ${p.reason}`);
      return resolved;
    }
    log(`    SearXNG unavailable (${p.reason.split(".")[0]}) — falling back to the built-in engines`);
  }

  /* SERPAPI — after SearXNG, before the built-in engines.
   *
   * Ordered this way on purpose. SearXNG is free and unmetered, so it must
   * carry bulk keyword sweeps (hundreds of queries per run). SerpAPI is real
   * Google but capped at 250 searches a MONTH on this plan — one sweep would
   * exhaust it and then every dependent channel would report nothing.
   *
   * Its value is that it is HOSTED: unlike SearXNG it works from a serverless
   * function, so it is the provider that keeps SERP-dependent channels alive
   * where the app actually runs. Used sparingly, cached for a day. */
  const wantSerpApi = MODE === "serpapi" || MODE === "auto";
  if (wantSerpApi && serpapi.configured()) {
    const p = await serpapi.probe();
    if (p.ok) {
      resolved = {
        id: "serpapi",
        label: "SerpAPI (real Google, hosted)",
        search: (q, o = {}) => serpapi.search(q, { ...o, log: o.log }),
        note:
          p.detail +
          ". Hosted, so it works from a serverless function where SearXNG cannot. " +
          "Capped at 250 searches/month, cached 24h, with a reserve held back — a quota stop " +
          "reports as not-checked rather than as an empty result.",
        degraded: false,
        metered: true,
        searches_left: p.searches_left,
        capabilities: {
          provider: "serpapi",
          site_operator: true,
          qualifier_terms: true,
          date_filter: false,
          serves_channels: ["web", "blog", "linkedin", "x", "video", "event"],
          cannot_serve_channels: [],
        },
      };
      log(`    SERP provider: ${p.detail}`);
      return resolved;
    }
    log(`    SerpAPI unavailable (${String(p.reason).slice(0, 70)}) — falling back`);
    if (MODE === "serpapi") {
      resolved = {
        id: "none", label: "none",
        search: async () => ({ ok: false, results: [], error: p.reason }),
        note: `SERP_PROVIDER=serpapi was requested but ${p.reason}`,
        unavailable: true, degraded: true,
      };
      return resolved;
    }
  }

  if (wantBuiltin) {
    const p = await builtin.probe();
    if (p.ok) {
      resolved = {
        id: "builtin",
        label: "Built-in Node metasearch (DuckDuckGo + Bing)",
        search: (q, o) => builtin.search(q, o),
        note:
          p.detail +
          ". No Docker or Python required, but materially weaker than SearXNG: " +
          builtin.CAPABILITIES.reliability +
          " It cannot serve the " +
          builtin.CAPABILITIES.cannot_serve_channels.join(", ") +
          " channels at all, because neither engine honours the site: operator or qualifier terms.",
        degraded: true, // always narrower than SearXNG
        builtin_degraded: p.degraded,
        capabilities: builtin.CAPABILITIES,
      };
      log(`    SERP provider: ${p.detail}`);
      return resolved;
    }
    resolved = {
      id: "none",
      label: "none",
      search: async () => ({ ok: false, results: [], error: p.reason }),
      note: `No SERP provider available. ${p.reason}`,
      unavailable: true,
      degraded: true,
    };
    log(`    SERP provider: UNAVAILABLE — ${p.reason}`);
    return resolved;
  }

  resolved = {
    id: "none",
    label: "none",
    search: async () => ({ ok: false, results: [], error: `SERP_PROVIDER=${MODE} disables all providers` }),
    note: `SERP_PROVIDER=${MODE}`,
    unavailable: true,
    degraded: true,
  };
  return resolved;
}

/** Reset the cache (tests). */
function _reset() { resolved = null; }

module.exports = { resolve, MODE, _reset };
