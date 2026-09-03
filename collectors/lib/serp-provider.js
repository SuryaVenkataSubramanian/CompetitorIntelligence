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

const MODE = (process.env.SERP_PROVIDER || "auto").toLowerCase();

let resolved = null; // cached for the life of the process

async function resolve({ log = () => {} } = {}) {
  if (resolved) return resolved;

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
