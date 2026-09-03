/**
 * The refresh loop body, run detached by refresh-service.js.
 *
 * Separate file so the service can spawn a clean process it fully controls,
 * rather than daemonising itself.
 *
 * Every tick:
 *   0. ensure SearXNG is up — restart it if it died, because without it the
 *      Events channel, LinkedIn/X discovery and Google News resolution all stop
 *      and the tick would quietly collect almost nothing
 *   1. free sources for every brand (blog RSS, YouTube RSS, Hacker News)
 *   2. SearXNG for the next brand(s) on a persisted rolling cursor
 *   3. rebuild data/
 */
const { spawnSync } = require("child_process");
const path = require("path");
const { tick } = require("./refresh-hourly");
const { searxngUp } = require("./refresh-service");

const INTERVAL_MS = Number(process.env.REFRESH_INTERVAL_MS || 3600000);
const RUN_LOCAL = path.join(__dirname, "searxng", "run-local.js");

function stamp() {
  return new Date().toISOString();
}

async function ensureSearxng() {
  if (await searxngUp()) return true;
  console.log(`[${stamp()}] SearXNG is down — restarting it`);
  const r = spawnSync(process.execPath, [RUN_LOCAL], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    timeout: 120000,
  });
  const ok = await searxngUp();
  console.log(`[${stamp()}] SearXNG restart ${ok ? "succeeded" : "FAILED"}`);
  if (!ok && r.stdout) console.log(String(r.stdout).trim().split("\n").slice(-5).join("\n"));
  return ok;
}

async function once() {
  try {
    const up = await ensureSearxng();
    if (!up) {
      console.log(`[${stamp()}] proceeding without SearXNG — free sources only this tick`);
    }
    tick();
  } catch (e) {
    // Never let one bad tick kill the service; the next one may well succeed.
    console.log(`[${stamp()}] tick threw: ${e && e.stack ? e.stack : e}`);
  }
}

console.log(`\n[${stamp()}] refresh loop started, interval ${Math.round(INTERVAL_MS / 60000)} min, pid ${process.pid}`);

// Graceful shutdown so `refresh:stop` produces a clean log rather than a silent gap.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    console.log(`[${stamp()}] received ${sig} — shutting down`);
    process.exit(0);
  });
}

once();
setInterval(once, INTERVAL_MS);
