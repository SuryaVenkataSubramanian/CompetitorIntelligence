/**
 * Starts the LOCAL SearXNG (no Docker) — `npm run searxng:local`
 *
 * SearXNG officially supports Linux only. It nevertheless runs on Windows because
 * none of its declared dependencies are Linux-only, but three things must be set
 * up correctly, and forgetting any one of them produces a confusing failure:
 *
 *  1. SEARXNG_SETTINGS_PATH  -> settings-local.yml, which enables `formats: [html, json]`.
 *     SearXNG ships with the JSON API DISABLED; without this every collector
 *     request returns an HTML page and the adapter (correctly) refuses to parse it.
 *
 *  2. PYTHONPATH             -> ./winshim, providing a `pwd` module. `searx/webapp.py`
 *     -> `limiter.py` -> `valkeydb.py` imports POSIX-only `pwd` at module level, so
 *     SearXNG cannot start on Windows without it. See winshim/pwd.py for why the
 *     shim is safe (one unreachable log line).
 *
 *  3. The venv interpreter    -> vendor/searxng/.venv, NOT the system Python.
 *
 * `--status` reports whether an instance is already answering, so this is safe to
 * run repeatedly.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..", "..");
const SEARX_DIR = path.join(ROOT, "vendor", "searxng");
const VENV_PY = path.join(SEARX_DIR, ".venv", "Scripts", "python.exe");
const VENV_PY_NIX = path.join(SEARX_DIR, ".venv", "bin", "python");
const SETTINGS = path.join(__dirname, "settings-local.yml");
const SHIM = path.join(__dirname, "winshim");
const LOG = path.join(__dirname, "searxng-local.log");
const PORT = process.env.SEARXNG_PORT || 8888;

function pythonBin() {
  if (fs.existsSync(VENV_PY)) return VENV_PY;
  if (fs.existsSync(VENV_PY_NIX)) return VENV_PY_NIX;
  return null;
}

function status() {
  return new Promise(resolve => {
    const req = http.get(
      { host: "127.0.0.1", port: PORT, path: "/search?q=ping&format=json", timeout: 8000 },
      res => {
        let body = "";
        res.on("data", d => (body += d));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(body); } catch (e) { /* not json */ }
          resolve({
            up: true,
            status: res.statusCode,
            json_api: !!json,
            content_type: res.headers["content-type"] || null,
            results: json ? (json.results || []).length : null,
          });
        });
      }
    );
    req.on("timeout", () => { req.destroy(); resolve({ up: false, reason: "timeout" }); });
    req.on("error", e => resolve({ up: false, reason: e.code || e.message }));
  });
}

function preflight() {
  const problems = [];
  if (!fs.existsSync(SEARX_DIR)) {
    problems.push(
      `vendor/searxng missing. Clone it:\n` +
        `    git clone --depth 1 https://github.com/searxng/searxng.git vendor/searxng\n` +
        `  NOTE: 4 files fail to check out on Windows ('...searxng.conf:socket' — a colon is\n` +
        `  illegal in NTFS filenames). They are nginx/uwsgi deployment templates and are not\n` +
        `  needed; the application itself checks out fine.`
    );
  }
  if (!pythonBin()) {
    problems.push(
      `vendor/searxng/.venv missing. Create it:\n` +
        `    winget install --id Python.Python.3.12 --scope user\n` +
        `    <python> -m venv vendor/searxng/.venv\n` +
        `    vendor/searxng/.venv/Scripts/python -m pip install -r vendor/searxng/requirements.txt`
    );
  }
  if (!fs.existsSync(SETTINGS)) problems.push(`settings-local.yml missing at ${SETTINGS}`);
  if (!fs.existsSync(path.join(SHIM, "pwd.py"))) {
    problems.push(`winshim/pwd.py missing — SearXNG cannot import on Windows without it`);
  }
  return problems;
}

(async () => {
  const arg = process.argv[2];

  if (arg === "--status") {
    const s = await status();
    if (!s.up) {
      console.log(`\n  SearXNG is NOT running on port ${PORT} (${s.reason})\n  start it: npm run searxng:local\n`);
      process.exit(1);
    }
    console.log(`\n  SearXNG is up on port ${PORT}`);
    console.log(`    HTTP ${s.status}, content-type: ${s.content_type}`);
    console.log(`    JSON API: ${s.json_api ? "ENABLED" : "DISABLED — check `formats` in settings-local.yml"}`);
    console.log("");
    process.exit(s.json_api ? 0 : 1);
  }

  const problems = preflight();
  if (problems.length) {
    console.error("\nCannot start local SearXNG:\n");
    problems.forEach(p => console.error("  - " + p + "\n"));
    process.exit(1);
  }

  const existing = await status();
  if (existing.up) {
    console.log(`\n  Already running on port ${PORT} (JSON API ${existing.json_api ? "enabled" : "DISABLED"}).\n`);
    process.exit(existing.json_api ? 0 : 1);
  }

  const bin = pythonBin();
  console.log(`\nStarting SearXNG (local, no Docker)`);
  console.log(`  python:   ${bin}`);
  console.log(`  settings: ${path.relative(ROOT, SETTINGS)}`);
  console.log(`  shim:     ${path.relative(ROOT, SHIM)} (provides POSIX 'pwd')`);
  console.log(`  log:      ${path.relative(ROOT, LOG)}`);

  const out = fs.openSync(LOG, "a");
  const child = spawn(bin, ["-m", "searx.webapp"], {
    cwd: SEARX_DIR,
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      SEARXNG_SETTINGS_PATH: SETTINGS,
      // Prepend so the shim wins over anything else on the path.
      PYTHONPATH: SHIM + path.delimiter + (process.env.PYTHONPATH || ""),
      PYTHONUNBUFFERED: "1",
    },
  });
  child.unref();

  // Poll rather than sleeping a fixed amount — engine init takes a variable time.
  const deadline = Date.now() + 60000;
  let s = { up: false };
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2500));
    s = await status();
    if (s.up) break;
  }

  if (!s.up) {
    console.error(`\n  Did not come up within 60s. Last 20 log lines:\n`);
    try {
      const lines = fs.readFileSync(LOG, "utf8").trim().split("\n").slice(-20);
      lines.forEach(l => console.error("    " + l));
    } catch (e) { /* no log */ }
    process.exit(1);
  }

  console.log(`\n  Up on http://127.0.0.1:${PORT}  (pid ${child.pid})`);
  console.log(`  JSON API: ${s.json_api ? "enabled" : "DISABLED — check `formats` in settings-local.yml"}`);
  console.log(`\n  Now run:  SEARXNG_URL=http://127.0.0.1:${PORT} npm run collect\n`);
  process.exit(s.json_api ? 0 : 1);
})();
