/**
 * The collector runner.
 *
 *   node collectors/collect.js [--days=90] [--only=gdelt,youtube] [--brand=gitbook]
 *
 * Runs every adapter, pushes candidates through the single verification
 * pipeline, merges into the evidence store, and writes a coverage report that
 * states exactly which sources ran, which were dormant and why, and where a
 * requested date range exceeds what a source can serve.
 *
 * The coverage report is not decoration — the dashboard reads it and renders the
 * gaps, so a business user can see that (say) a 365-day X figure is a floor from
 * public search indexing rather than a true total.
 */
const { verifyCandidates } = require("./lib/pipeline");
const { upsertMentions, logRun, writeJson, STORE_DIR } = require("./lib/store");
const { allBrands } = require("./lib/brands");
const path = require("path");

const ADAPTERS = [
  require("./adapters/octolens"),
  require("./adapters/newsapi"),
  require("./adapters/blogfeed"),
  require("./adapters/youtube"),
  require("./adapters/hackernews"),
  require("./adapters/googlenews"),
  require("./adapters/gdelt"),
  require("./adapters/searxng"),
  require("./adapters/linkedin"),
  require("./adapters/linkedin-brightdata"),
  require("./adapters/x_twikit"),
];

function parseArgs(argv) {
  const a = { days: 90, only: null, brand: null, stages: null };
  for (const raw of argv.slice(2)) {
    const [k, v] = raw.replace(/^--/, "").split("=");
    if (k === "days") a.days = Math.max(1, parseInt(v, 10) || 90);
    if (k === "only") a.only = v.split(",").map(s => s.trim()).filter(Boolean);
    if (k === "brand") a.brand = v;
    // Multi-stage adapters (linkedin_brightdata) accept a stage subset, so a
    // single expensive stage can be re-run without repeating the cheap ones.
    if (k === "stages") a.stages = v.split(",").map(s => s.trim()).filter(Boolean);
  }
  return a;
}

(async () => {
  const args = parseArgs(process.argv);
  const started = new Date().toISOString();
  console.log(`\nCollecting competitive intelligence — window: ${args.days} days`);
  console.log(`Brands: ${allBrands().map(b => b.name).join(", ")}\n`);

  // Fast, unthrottled, first-party sources first. They make the dashboard fresh
  // within seconds; the rate-limited discovery sources then add breadth on top.
  // linkedin_brightdata runs late: its Bright Data collections legitimately take
  // minutes, so the fast sources should already have refreshed the dashboard.
  const PRIORITY = ["octolens", "newsapi", "blogfeed", "youtube", "hackernews", "searxng", "googlenews", "gdelt", "linkedin", "x_twikit", "linkedin_brightdata"];
  const adapters = (args.only ? ADAPTERS.filter(a => args.only.includes(a.id)) : ADAPTERS)
    .slice()
    .sort((a, b) => PRIORITY.indexOf(a.id) - PRIORITY.indexOf(b.id));
  const coverage = [];
  const perAdapterStats = [];
  const providerStats = {};
  let dedupeRemoved = 0;
  const dedupeGroups = [];
  let verifiedTotal = 0, addedTotal = 0, storeTotal = 0;
  const allGaps = [];
  const allRejections = [];

  for (const ad of adapters) {
    const label = `${ad.id}`.padEnd(12);
    console.log(`▸ ${ad.label}`);
    const t0 = Date.now();
    let res;
    try {
      res = await ad.collect({
        sinceDays: args.days,
        brands: args.brand ? [args.brand] : null,
        log: m => console.log(m),
        ...(args.stages ? { stages: args.stages } : {}),
      });
    } catch (e) {
      console.log(`    ERROR: ${e.message}`);
      coverage.push({
        adapter: ad.id,
        label: ad.label,
        status: "error",
        error: String(e.message || e),
        candidates: 0,
        requires: ad.requires || [],
      });
      continue;
    }

    if (res.providerStats) providerStats[ad.id] = res.providerStats;
    let cands = res.candidates || [];
    if (args.brand) cands = cands.filter(c => c.brand_id === args.brand);
    (res.gaps || []).forEach(g => allGaps.push({ adapter: ad.id, ...g }));

    // PERSIST PER ADAPTER, not once at the end.
    //
    // Batching every adapter's verification to the end of the run made the fast,
    // reliable first-party sources (blog RSS, YouTube RSS: seconds, no rate
    // limits) hostage to the slowest and least reliable (GDELT 429 retries, then
    // 469 SearXNG queries). Measured consequence: live feeds carried posts up to
    // Aug 24 while the dashboard still showed Aug 12, because the run had not
    // reached the single verification step — and an interrupted run persisted
    // nothing at all.
    //
    // Verifying and storing each adapter's output as it completes means the
    // dashboard goes fresh within seconds of the first adapter finishing, and a
    // run that dies halfway keeps everything collected up to that point.
    if (cands.length) {
      const v = await verifyCandidates(cands, { concurrency: 16, log: m => console.log(m) });

      // Cross-API dedupe: fold this adapter's output in against everything already
      // stored, so a syndicated copy arriving from a second API does not become a
      // second mention. Canonical URL alone misses those; see lib/dedupe.js.
      const { dedupe } = require("./lib/dedupe");
      const existing = require("./lib/store").loadMentions().records;
      const ded = dedupe([...existing, ...v.records]);
      const keptNew = ded.records.filter(r => !existing.some(e => e.canonical_url === r.canonical_url && e.brand_id === r.brand_id));
      if (ded.removed) {
        dedupeRemoved += ded.removed;
        dedupeGroups.push(...ded.groups);
        console.log(`    dedupe: collapsed ${ded.removed} duplicate(s) across sources`);
      }
      const m = upsertMentions(keptNew.length ? keptNew : v.records);
      perAdapterStats.push({ adapter: ad.id, ...v.stats });
      allRejections.push(...v.rejections);
      verifiedTotal += v.stats.verified;
      addedTotal += m.added;
      storeTotal = m.total;
      console.log(`    stored: +${m.added} new, ${m.updated} updated → ${m.total} records`);
    }

    const status = res.unavailable ? "dormant" : cands.length ? "ok" : "empty";
    coverage.push({
      adapter: ad.id,
      label: ad.label,
      status,
      candidates: cands.length,
      requires: ad.requires || [],
      coverage_limit: ad.coverageLimit || null,
      connection: typeof ad.connectionStatus === "function" ? ad.connectionStatus() : null,
      ms: Date.now() - t0,
    });
    console.log(`    → ${cands.length} candidates  [${status}]  ${Date.now() - t0}ms\n`);
  }

  // Verification and storage already happened per adapter above, so there is no
  // batched pass here. These are just the run totals.
  const stats = perAdapterStats.reduce((a, s) => {
    for (const k of Object.keys(s)) if (typeof s[k] === "number") a[k] = (a[k] || 0) + s[k];
    return a;
  }, {});
  const merged = { added: addedTotal, updated: 0, total: storeTotal, verified: verifiedTotal };
  console.log(
    `\n▸ Run totals: +${addedTotal} new · ${verifiedTotal} verified · ${storeTotal} records in store`
  );

  // Per-brand / per-channel verified counts, so the report matches the dashboard.
  const matrix = {};
  for (const b of allBrands()) matrix[b.id] = {};
  const { loadMentions } = require("./lib/store");
  for (const r of loadMentions().records) {
    matrix[r.brand_id] = matrix[r.brand_id] || {};
    matrix[r.brand_id][r.channel] = (matrix[r.brand_id][r.channel] || 0) + 1;
  }

  // Record which SERP provider actually served this run. SearXNG and the built-in
  // metasearch have materially different recall and channel coverage, so a
  // business user reading a competitor count needs to know which produced it.
  let serpProvider = null;
  try {
    const p = await require("./lib/serp-provider").resolve();
    serpProvider = {
      id: p.id,
      label: p.label,
      note: p.note,
      degraded: !!p.degraded,
      capabilities: p.capabilities || null,
    };
  } catch (e) {
    serpProvider = { id: "unknown", label: "unknown", note: String(e.message || e), degraded: true };
  }

  const report = {
    started_at: started,
    finished_at: new Date().toISOString(),
    window_days: args.days,
    brand_filter: args.brand || null,
    serp_provider: serpProvider,
    adapters: coverage,
    verification: stats,
    per_adapter: perAdapterStats,
    provider_stats: providerStats,
    dedupe: { removed: dedupeRemoved, groups: dedupeGroups.slice(0, 200) },
    store: merged,
    this_run_by_brand_channel: matrix,
    gaps: allGaps,
    rejections: allRejections.slice(0, 400),
    rejection_total: allRejections.length,
  };
  writeJson(path.join(STORE_DIR, "coverage.json"), report);
  logRun({
    window_days: args.days,
    adapters: coverage.map(c => ({ id: c.adapter, status: c.status, candidates: c.candidates })),
    verified: stats.verified,
    added: merged.added,
  });

  console.log("\n── This run, verified records by brand × channel ──");
  const channels = require("./lib/record").CHANNEL_IDS;
  console.log("brand".padEnd(15) + channels.map(c => c.padStart(9)).join(""));
  for (const b of allBrands()) {
    const row = channels.map(c => String(matrix[b.id]?.[c] || 0).padStart(9)).join("");
    console.log(b.name.padEnd(15) + row);
  }

  const dormant = coverage.filter(c => c.status === "dormant");
  if (dormant.length) {
    console.log("\n── Dormant sources (no credential — contributing nothing, not estimated) ──");
    for (const d of dormant) {
      console.log(`  ${d.adapter}: ${(d.connection?.blockers || []).join(" / ") || "unavailable"}`);
    }
  }
  if (allGaps.length) {
    console.log(`\n── ${allGaps.length} coverage gap(s) recorded in store/coverage.json ──`);
    for (const g of allGaps.slice(0, 8)) console.log(`  [${g.adapter}] ${g.reason}`);
    if (allGaps.length > 8) console.log(`  … and ${allGaps.length - 8} more`);
  }

  console.log("\nNext: npx claude-code /refresh-intel  (Claude classifies sentiment + measures AI visibility)");
  console.log("  or: node collectors/build.js        (rebuild data/ from what is already classified)\n");
})();
