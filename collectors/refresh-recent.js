#!/usr/bin/env node
/**
 * Fast incremental refresh — the path that keeps the recent view current.
 *
 *   npm run refresh:recent              last 7 days
 *   npm run refresh:recent -- --days=2  tighter window, faster
 *   npm run refresh:recent -- --full    include the slow discovery sources
 *
 * WHY A SEPARATE ENTRY POINT
 * --------------------------
 * A full `collect.js` run takes tens of minutes: SearXNG sweeps hundreds of
 * queries, GDELT is throttled to one request per five seconds, and the
 * LinkedIn stages each wait on a Bright Data snapshot. Run that on a schedule
 * and it is still going when the next tick starts.
 *
 * This runs only the sources that answer in seconds-to-minutes and that carry
 * exact timestamps, over a short window. That is what makes a frequent cron
 * viable, and a frequent cron is the only thing that actually keeps a hosted
 * dashboard fresh — the app itself cannot collect, because a serverless
 * function has neither the runtime nor the filesystem for it.
 *
 * ADAPTERS INCLUDED, AND WHY EACH EARNS ITS PLACE
 * ----------------------------------------------
 *   octolens        keyword mentions, provider-dated, one paged API call
 *   blogfeed        first-party RSS, exact dates, no rate limit
 *   youtube         channel RSS, exact timestamps, no key or quota
 *   x_brightdata    owned X timelines; needs no account, unlike the retired
 *                   credential adapter that never once collected
 *   hackernews      free, exact ISO dates, fast
 *
 * EXCLUDED unless --full: searxng (a local service, and hundreds of queries),
 * gdelt (5s throttle), googlenews (needs SERP resolution), newsapi (returns
 * almost nothing now), linkedin_brightdata (multi-stage, minutes per stage).
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");

const FAST = ["octolens", "blogfeed", "youtube", "hackernews", "x_brightdata"];
const FULL = [...FAST, "newsapi", "linkedin_brightdata", "searxng", "googlenews", "gdelt"];

function arg(k, d) {
  const a = process.argv.find(x => x.startsWith(`--${k}=`));
  return a ? a.split("=")[1] : d;
}

const days = Math.max(1, parseInt(arg("days", "7"), 10) || 7);
const full = process.argv.includes("--full");
const adapters = full ? FULL : FAST;

function run(script, args) {
  return new Promise(resolve => {
    const c = spawn(process.execPath, [path.join(__dirname, script), ...args], { cwd: ROOT });
    let out = "";
    c.stdout.on("data", d => { const s = d.toString(); out += s; process.stdout.write(s); });
    c.stderr.on("data", d => { const s = d.toString(); out += s; process.stderr.write(s); });
    c.on("close", code => resolve({ ok: code === 0, code, out }));
    c.on("error", e => resolve({ ok: false, code: -1, out: String(e.message) }));
  });
}

/** Newest record in the store, and how old it is right now. */
function freshness() {
  try {
    const store = JSON.parse(fs.readFileSync(path.join(ROOT, "collectors", "store", "mentions.json"), "utf8"));
    let newest = null;
    for (const r of store.records || []) {
      const d = r.published_at || r.first_seen;
      if (d && (!newest || d > newest)) newest = d;
    }
    if (!newest) return { newest: null };
    const ageMin = Math.round((Date.now() - new Date(newest).getTime()) / 60000);
    return {
      newest,
      age_minutes: ageMin,
      age_human: ageMin < 60 ? `${ageMin} min`
        : ageMin < 1440 ? `${Math.round(ageMin / 60)} h`
          : `${Math.round(ageMin / 1440)} d`,
    };
  } catch (e) {
    return { newest: null, error: String(e.message || e) };
  }
}

(async () => {
  const t0 = Date.now();
  const before = freshness();

  console.log(`\n  Fast refresh — last ${days} day(s), ${adapters.length} source(s)`);
  console.log(`  ${adapters.join(", ")}`);
  console.log(`  newest record before: ${before.newest || "none"}${before.age_human ? ` (${before.age_human} old)` : ""}\n`);

  const collect = await run("collect.js", [`--days=${days}`, `--only=${adapters.join(",")}`]);
  if (!collect.ok) console.log(`\n  ! collection exited ${collect.code} — rebuilding from whatever was stored`);

  console.log("\n  rebuilding data/ ...");
  const build = await run("build.js", []);
  if (!build.ok) {
    console.error(`\n  ! build failed (${build.code}). data/ is unchanged.\n`);
    process.exit(1);
  }

  const after = freshness();
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  console.log("");
  console.log(`  done in ${secs}s`);
  console.log(`  newest record now: ${after.newest || "none"}${after.age_human ? ` (${after.age_human} old)` : ""}`);
  if (before.newest && after.newest && after.newest > before.newest) {
    console.log(`  advanced from ${before.newest.slice(0, 16).replace("T", " ")} to ${after.newest.slice(0, 16).replace("T", " ")}`);
  } else if (before.newest === after.newest) {
    console.log("  no newer records were published by these sources since the last run.");
  }
  console.log("");

  // A machine-readable receipt, so the dashboard can show exactly how fresh the
  // data is and when it was last attempted rather than only when it was built.
  const receipt = {
    refreshed_at: new Date().toISOString(),
    window_days: days,
    mode: full ? "full" : "fast",
    adapters,
    duration_seconds: Number(secs),
    newest_before: before.newest || null,
    newest_after: after.newest || null,
    newest_age_minutes: after.age_minutes ?? null,
    advanced: !!(before.newest && after.newest && after.newest > before.newest),
    collect_exit: collect.code,
  };
  fs.writeFileSync(
    path.join(ROOT, "data", "refresh-receipt.json"),
    JSON.stringify(receipt, null, 2)
  );
  console.log(`  receipt: data/refresh-receipt.json\n`);
})();
