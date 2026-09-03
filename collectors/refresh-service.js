/**
 * Detached refresh service.  npm run refresh:start | refresh:stop | refresh:status
 *
 * `refresh:hourly` runs in the foreground and dies with the terminal, so the
 * dashboard went stale the moment the shell closed — which is exactly what
 * happened: no collection ran for 12 days.
 *
 * This starts the same loop DETACHED, writes a pidfile, and keeps a rolling log,
 * so it survives the terminal closing and can be stopped deliberately. It also
 * self-heals two things the loop depends on:
 *
 *   1. SearXNG — the loop is useless without it, so the service checks the
 *      instance on every tick and restarts it if it has died.
 *   2. A stale pidfile from an unclean shutdown, which would otherwise make
 *      `refresh:start` refuse to run forever.
 *
 * It does NOT classify sentiment. That needs Claude, and an unattended process
 * must not invent classifications — new records land as `unclassified` (excluded
 * from sentiment metrics) until /refresh-intel runs.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const STORE = path.join(__dirname, "store");
const PIDFILE = path.join(STORE, "refresh-service.pid");
const LOG = path.join(STORE, "refresh-service.log");
const RUNNER = path.join(__dirname, "refresh-loop.js");

function readPid() {
  try {
    const p = parseInt(fs.readFileSync(PIDFILE, "utf8").trim(), 10);
    return Number.isFinite(p) ? p : null;
  } catch (e) {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, does not kill
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but owned by another user
  }
}

function clearStalePid() {
  const pid = readPid();
  if (pid && !alive(pid)) {
    fs.unlinkSync(PIDFILE);
    return pid;
  }
  return null;
}

function start() {
  const stale = clearStalePid();
  if (stale) console.log(`  cleared stale pidfile (pid ${stale} is gone)`);

  const existing = readPid();
  if (alive(existing)) {
    console.log(`\n  Already running (pid ${existing}).`);
    console.log(`  Log:    ${path.relative(ROOT, LOG)}`);
    console.log(`  Stop:   npm run refresh:stop\n`);
    return;
  }

  if (!fs.existsSync(STORE)) fs.mkdirSync(STORE, { recursive: true });
  const out = fs.openSync(LOG, "a");
  const child = spawn(process.execPath, [RUNNER], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env },
  });
  child.unref();
  fs.writeFileSync(PIDFILE, String(child.pid));

  const mins = Math.round(Number(process.env.REFRESH_INTERVAL_MS || 3600000) / 60000);
  console.log(`\n  Refresh service started (pid ${child.pid}), every ${mins} min.`);
  console.log(`  It survives this terminal closing.`);
  console.log(`  Log:    ${path.relative(ROOT, LOG)}`);
  console.log(`  Status: npm run refresh:status`);
  console.log(`  Stop:   npm run refresh:stop\n`);
}

function stop() {
  const pid = readPid();
  if (!alive(pid)) {
    console.log(`\n  Not running${pid ? ` (stale pidfile for ${pid} removed)` : ""}.\n`);
    if (pid) { try { fs.unlinkSync(PIDFILE); } catch (e) {} }
    return;
  }
  try {
    // The loop spawns child collectors; kill the tree on Windows.
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGTERM");
    }
    console.log(`\n  Stopped refresh service (pid ${pid}).\n`);
  } catch (e) {
    console.log(`\n  Could not stop pid ${pid}: ${e.message}\n`);
  }
  try { fs.unlinkSync(PIDFILE); } catch (e) {}
}

/** Is SearXNG answering? The loop cannot collect without it. */
function searxngUp(port = process.env.SEARXNG_PORT || 8888) {
  return new Promise(resolve => {
    const req = http.get({ host: "127.0.0.1", port, path: "/search?q=ping&format=json", timeout: 8000 }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

async function status() {
  const pid = readPid();
  const running = alive(pid);
  const sx = await searxngUp();

  const { loadMentions, readJson } = require("./lib/store");
  const store = loadMentions();
  const cursor = readJson(path.join(STORE, "refresh-cursor.json"), {});
  const newest = store.records
    .map(r => r.first_seen || r.fetched_at)
    .filter(Boolean)
    .sort()
    .pop();
  const staleDays = newest ? Math.round((Date.now() - new Date(newest).getTime()) / 864e5) : null;

  console.log(`\nRefresh service`);
  console.log(`  service:    ${running ? `RUNNING (pid ${pid})` : "STOPPED"}`);
  console.log(`  SearXNG:    ${sx ? "up" : "DOWN — the loop restarts it automatically on the next tick"}`);
  console.log(`  ticks run:  ${cursor.ticks || 0}   full cycles: ${cursor.cycles || 0}`);
  console.log(`  last tick:  ${cursor.last_tick_at || "never"}`);
  console.log(`  next slice: ${(cursor.next_slice || []).join(", ") || "-"}`);
  console.log(`\n  store:      ${store.records.length} records`);
  console.log(`  newest:     ${newest || "-"}${staleDays != null ? `   (${staleDays} day(s) old)` : ""}`);
  console.log(`  unclassified: ${store.records.filter(r => !r.sentiment).length}`);
  if (!running) console.log(`\n  Start it:   npm run refresh:start`);
  console.log("");
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === "stop") stop();
  else if (cmd === "status") status();
  else start();
}

module.exports = { start, stop, status, searxngUp };
