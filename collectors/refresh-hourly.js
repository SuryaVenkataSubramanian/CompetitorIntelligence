/**
 * Hourly incremental refresh.  `npm run refresh:hourly`  (or `--once`)
 *
 * WHY THIS IS NOT JUST `collect.js` ON A TIMER
 * -------------------------------------------
 * A full sweep is ~63 SearXNG queries and `google cse` suspends after roughly 40.
 * Running that every hour would spend most of its time rate-limited and would keep
 * the engine permanently suspended, so each run would collect less than the last.
 *
 * So this rotates: each tick collects a SLICE (one or two brands from a rolling
 * cursor) plus all the free, unthrottled sources (blog RSS, YouTube RSS, Hacker
 * News) for everyone. Over a full cycle every brand is covered, and the engine is
 * never asked for more than it will give.
 *
 * The cursor is persisted, so restarts resume rather than starting over and
 * re-hammering the first brand.
 *
 * Each tick:
 *   1. free sources for all brands (no rate limit, always safe)
 *   2. SearXNG for the next brand(s) on the cursor
 *   3. rebuild data/
 *   4. append a run entry so gaps in the schedule are visible
 *
 * Sentiment classification is deliberately NOT in this loop: it needs Claude, and
 * an unattended process cannot invent classifications. New records land as
 * `unclassified` (correctly excluded from sentiment metrics) until /refresh-intel
 * runs. `npm run refresh:status` reports the backlog.
 */
const { spawnSync } = require("child_process");
const path = require("path");
const { readJson, writeJson, STORE_DIR, loadMentions } = require("./lib/store");
const { brandOrder, brand } = require("./lib/brands");

const CURSOR = path.join(STORE_DIR, "refresh-cursor.json");
const INTERVAL_MS = Number(process.env.REFRESH_INTERVAL_MS || 3600000); // 1 hour
const BRANDS_PER_TICK = Number(process.env.REFRESH_BRANDS_PER_TICK || 2);
const WINDOW_DAYS = Number(process.env.REFRESH_WINDOW_DAYS || 90);

const node = process.execPath;
const COLLECT = path.join(__dirname, "collect.js");
const BUILD = path.join(__dirname, "build.js");

function run(args, label) {
  const t0 = Date.now();
  const r = spawnSync(node, args, { encoding: "utf8", cwd: path.join(__dirname, "..") });
  const out = (r.stdout || "") + (r.stderr || "");
  const added = /\+(\d+) new/.exec(out);
  const verified = /(\d+) verified \//.exec(out);
  return {
    label,
    ok: r.status === 0,
    ms: Date.now() - t0,
    added: added ? Number(added[1]) : 0,
    verified: verified ? Number(verified[1]) : 0,
    // Keep the tail so a failing tick is diagnosable from the log alone.
    tail: out.trim().split("\n").slice(-6).join(" | ").slice(0, 600),
  };
}

function loadCursor() {
  return readJson(CURSOR, { index: 0, cycles: 0, ticks: 0, history: [] });
}

function tick() {
  const started = new Date().toISOString();
  const order = brandOrder();
  const cur = loadCursor();

  const slice = [];
  for (let i = 0; i < BRANDS_PER_TICK; i++) {
    slice.push(order[(cur.index + i) % order.length]);
  }
  const nextIndex = (cur.index + BRANDS_PER_TICK) % order.length;
  const completedCycle = cur.index + BRANDS_PER_TICK >= order.length;

  console.log(`\n[${started}] tick ${cur.ticks + 1}`);
  console.log(`  free sources: all brands · SearXNG slice: ${slice.map(b => brand(b).name).join(", ")}`);

  const steps = [];

  // 1. Unthrottled first-party sources — safe to run every hour for everyone.
  steps.push(run(
    [COLLECT, `--days=${WINDOW_DAYS}`, "--only=blogfeed,youtube,hackernews"],
    "free-sources"
  ));

  // 2. SearXNG, one brand at a time, so a suspension costs one brand not the run.
  for (const b of slice) {
    steps.push(run([COLLECT, `--days=${WINDOW_DAYS}`, "--only=searxng", `--brand=${b}`], `searxng:${b}`));
  }

  // 3. Rebuild so the dashboard reflects the new records immediately.
  steps.push(run([BUILD], "build"));

  const totalAdded = steps.reduce((a, s) => a + s.added, 0);
  const failed = steps.filter(s => !s.ok);

  const store = loadMentions();
  const unclassified = store.records.filter(r => !r.sentiment).length;

  const entry = {
    at: started,
    tick: cur.ticks + 1,
    searxng_slice: slice,
    added: totalAdded,
    store_total: store.records.length,
    unclassified,
    failed: failed.map(f => ({ step: f.label, tail: f.tail })),
    steps: steps.map(s => ({ step: s.label, ok: s.ok, added: s.added, ms: s.ms })),
  };

  const history = [entry, ...(cur.history || [])].slice(0, 200);
  writeJson(CURSOR, {
    index: nextIndex,
    cycles: cur.cycles + (completedCycle ? 1 : 0),
    ticks: cur.ticks + 1,
    last_tick_at: started,
    next_slice: [order[nextIndex], order[(nextIndex + 1) % order.length]].slice(0, BRANDS_PER_TICK),
    interval_ms: INTERVAL_MS,
    history,
  });

  console.log(`  +${totalAdded} new · store ${store.records.length} · ${unclassified} unclassified`);
  for (const s of steps) {
    console.log(`    ${s.ok ? "ok  " : "FAIL"} ${s.label.padEnd(18)} +${s.added}  ${Math.round(s.ms / 1000)}s`);
  }
  if (failed.length) for (const f of failed) console.log(`    ! ${f.label}: ${f.tail.slice(0, 200)}`);
  if (unclassified) {
    console.log(`  note: ${unclassified} record(s) await Claude sentiment classification (run /refresh-intel).`);
  }
  return entry;
}

function status() {
  const cur = loadCursor();
  const store = loadMentions();
  console.log(`\nHourly refresh status`);
  console.log(`  ticks run:        ${cur.ticks}`);
  console.log(`  full cycles:      ${cur.cycles}  (a cycle = every brand covered by SearXNG)`);
  console.log(`  last tick:        ${cur.last_tick_at || "never"}`);
  console.log(`  next SearXNG slice: ${(cur.next_slice || []).join(", ") || "-"}`);
  console.log(`  store:            ${store.records.length} records, ${store.records.filter(r => !r.sentiment).length} unclassified`);
  const recent = (cur.history || []).slice(0, 8);
  if (recent.length) {
    console.log(`\n  recent ticks:`);
    for (const h of recent) {
      console.log(`    ${h.at}  +${String(h.added).padStart(3)}  ${h.searxng_slice.join("+").padEnd(24)}${h.failed.length ? "  FAILED: " + h.failed.map(f => f.step).join(",") : ""}`);
    }
  }
  console.log("");
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === "--status") {
    status();
  } else if (arg === "--once") {
    tick();
  } else {
    console.log(`Hourly refresh loop — every ${Math.round(INTERVAL_MS / 60000)} min, ${BRANDS_PER_TICK} brand(s) of SearXNG per tick.`);
    console.log(`A full cycle over ${brandOrder().length} brands takes ~${Math.ceil(brandOrder().length / BRANDS_PER_TICK)} hours.`);
    console.log(`Ctrl-C to stop.  Status any time: npm run refresh:status\n`);
    tick();
    setInterval(tick, INTERVAL_MS);
  }
}

module.exports = { tick, status };
