#!/usr/bin/env node
/**
 * Live sweep — the same engine the dashboard's Refresh buttons use.
 *
 *   npm run sweep                    all 7 products, last 7 days
 *   npm run sweep -- --days=2        tighter window
 *   npm run sweep -- --brand=mintlify
 *   npm run sweep -- --channels=linkedin,web
 *   npm run sweep -- --no-build      collect only, skip the rebuild
 *
 * WHY THIS EXISTS ALONGSIDE collect.js AND refresh-recent.js
 * ---------------------------------------------------------
 *   collect.js        runs every registered adapter over a long window. Tens of
 *                     minutes. The right tool for a backfill.
 *   refresh-recent.js spawns collect.js for the fast adapters. Still a child
 *                     process per adapter, and its adapter list is built around
 *                     providers that have since gone dark.
 *   this              one in-process pass over the eleven keyless sources plus
 *                     X and LinkedIn, sized for a cron tick. About a minute.
 *
 * It is the path that keeps a hosted dashboard current, because it is the only
 * one whose freshness does not depend on a billing balance. Point a scheduled
 * runner at it — see .github/workflows/refresh.yml.
 */
const { load } = require("./lib/env");
const live = require("./lib/live-refresh");

load();

function arg(k, d) {
  const a = process.argv.find(x => x.startsWith(`--${k}=`));
  return a ? a.split("=").slice(1).join("=") : d;
}

(async () => {
  const days = Math.max(1, Math.min(90, parseInt(arg("days", "7"), 10) || 7));
  const brandArg = arg("brand", null);
  const chanArg = arg("channels", null);
  const skipBuild = process.argv.includes("--no-build");

  const brands = brandArg ? brandArg.split(",").map(s => s.trim()).filter(Boolean) : null;
  const channels = chanArg ? chanArg.split(",").map(s => s.trim()).filter(Boolean) : null;

  console.log(`\n  Live sweep — last ${days} day(s)`);
  console.log(`  brands:   ${brands ? brands.join(", ") : "all 7"}`);
  console.log(`  channels: ${channels ? channels.join(", ") : "all"}`);
  console.log("");

  const r = await live.refresh({ brands, channels, days, log: m => console.log(m) });

  console.log("");
  console.log(`  window:    ${r.window_start}  ->  ${r.finished_at}`);
  console.log(`  found:     ${r.candidates_found} candidate(s) in ${r.duration_seconds}s`);
  console.log(`  verified:  ${r.records_verified}`);
  console.log(`  rejected:  ${r.rejected}${r.rejected ? "  (" + r.rejection_reasons.slice(0, 3).join("; ") + ")" : ""}`);
  console.log(`  added:     ${r.added_to_store}${r.store_total != null ? ` (store now ${r.store_total})` : ""}`);
  if (!r.persisted) console.log(`  ! not persisted: ${r.persist_note}`);

  console.log("\n  per source:");
  for (const p of r.per_source) {
    const mark = p.ok ? (p.candidates ? "  OK  " : "  --  ") : " FAIL ";
    console.log(`  [${mark}] ${String(p.id).padEnd(20)} ${String(p.candidates).padStart(4)} candidate(s)` +
      (p.ok ? "" : `  ${String(p.error).slice(0, 80)}`));
  }

  /* GAPS ARE PRINTED EVEN WHEN THE RUN SUCCEEDS. A source that could not be
   * queried and a source that found nothing produce the same number, and only
   * one of them means "nobody mentioned the product". */
  if (r.gaps.length) {
    console.log(`\n  gaps (${r.gaps.length}) — these are unqueried sources, NOT measured zeroes:`);
    for (const g of r.gaps.slice(0, 12)) {
      console.log(`    ${String(g.source || "?").padEnd(20)} ${String(g.reason).slice(0, 110)}`);
    }
  }

  if (!skipBuild && r.added_to_store > 0) {
    console.log("\n  rebuilding data/ ...");
    const b = await live.rebuild({ log: () => {} });
    if (b.ok) {
      console.log("  rebuilt.");
    } else if (b.skipped) {
      console.log(`  rebuild skipped: ${b.reason}`);
    } else {
      console.error(`  ! rebuild failed (exit ${b.code}). The store is updated; data/ is not.`);
      (b.log || []).forEach(l => console.error("    " + l));
      process.exit(1);
    }
  } else if (!skipBuild) {
    console.log("\n  nothing new to build.");
  }

  console.log("");
})().catch(e => {
  console.error("\n  sweep failed: " + (e && e.stack || e) + "\n");
  process.exit(1);
});
