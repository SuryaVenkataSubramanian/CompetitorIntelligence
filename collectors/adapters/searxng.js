/**
 * Adapter: SearXNG  →  channel derived from the result URL
 *
 * WHAT THIS IS NOW: one query per brand, one page, one parse.
 *
 * WHAT IT USED TO BE, AND WHY THAT WAS WRONG
 * ------------------------------------------
 * This file was 308 lines of query planning. It built per-brand "plans" with
 * five query angles, a page multiplier and a channel matrix — 67 queries per
 * brand, ~3,600 raw candidates each, and a hand-rolled backoff for the
 * "Suspended: too many requests" that inevitably followed at around query 40.
 *
 * That treated a search endpoint as an analysis engine. Everything it was
 * computing — which channel a result belongs to, whether the brand is really
 * mentioned, whether the date is real — is already done downstream by
 * lib/pipeline.js, on every source, once. Doing it here meant a second,
 * divergent copy of that logic, and it meant SearXNG failing took six channels
 * with it.
 *
 * SearXNG is a search endpoint. It has two:
 *
 *   GET /search?q=...&format=json    results
 *   GET /                            is it alive
 *
 * So that is all this uses. One phrase per brand, one page, and the shared
 * pipeline decides what any of it means. If a wider sweep is wanted, that is a
 * scheduling decision (run it more often), not a reason to build a query
 * planner here.
 */
const { allBrands, brand } = require("../lib/brands");
const searxng = require("../lib/searxng-client");

module.exports = {
  id: "searxng",
  label: "SearXNG (metasearch)",
  channel: null,          // derived from the result URL by the pipeline
  requires: ["SEARXNG_URL"],

  available() {
    return { ok: true, reason: null };
  },

  connectionStatus() {
    return {
      id: "searxng",
      label: "SearXNG (metasearch)",
      connected: true,
      blockers: [],
      how_to_enable:
        "Optional. Start a local instance with `npm run searxng:local`. When it is not " +
        "running this source reports a gap and the keyless sources carry the load.",
      fallback_in_use: "lib/freshsources.js (11 keyless sources)",
    };
  },

  async collect({ sinceDays = 90, brands = null, log = () => {} } = {}) {
    const candidates = [];
    const gaps = [];

    const p = await searxng.probe();
    if (!p.ok) {
      // ONE gap for the instance, not one per brand. Seven identical "SearXNG
      // is down" lines read as seven problems.
      gaps.push({ brand_id: null, reason: p.reason });
      log(`    ${p.reason}`);
      return { candidates, gaps };
    }

    const wanted = allBrands().filter(b => !brands || brands.includes(b.id));
    for (const b of wanted) {
      // ONE PHRASE. Quoted, because an unquoted multi-word alias matches each
      // word separately on most engines.
      const q = `"${brand(b.id).aliases[0]}"`;
      const r = await searxng.search(q, { days: sinceDays });

      if (!r.ok) {
        gaps.push({ brand_id: b.id, reason: `SearXNG query failed: ${r.error}` });
        continue;
      }

      let kept = 0;
      for (const hit of r.results || []) {
        if (!hit.url) continue;
        const text = [hit.title, hit.content].filter(Boolean).join(". ");
        if (!text) continue;

        candidates.push({
          brand_id: b.id,
          channel: null,               // the pipeline derives this from the URL
          url: hit.url,
          title: hit.title || null,
          // SearXNG's publishedDate is engine-supplied and frequently absent or
          // wrong. The pipeline proves a date from the page itself; passing a
          // guess here would let an engine's guess become our stored fact.
          published_at: null,
          date_method: null,
          source_text: text,
          source_verified: true,
          source_adapter: "searxng",
          discovered_via: `searxng: ${q}`,
          author: null,
          extra: { searxng_engine: hit.engine || null, searxng_score: hit.score ?? null },
        });
        kept++;
      }
      log(`    ${b.name}: ${kept} result(s)`);

      if ((r.unresponsive_engines || []).length) {
        gaps.push({
          brand_id: b.id,
          reason: `engines did not answer: ${r.unresponsive_engines
            .map(e => (Array.isArray(e) ? e.join(" ") : e)).join(", ")}`,
        });
      }
    }

    return { candidates, gaps };
  },
};
