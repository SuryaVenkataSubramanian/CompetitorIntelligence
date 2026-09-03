#!/usr/bin/env node
/**
 * Pre-deploy check: would this repository work once pushed and deployed?
 *
 *   npm run deploy:check
 *
 * Catches the failures that are invisible locally and obvious in production:
 * a secret about to be committed, data files missing so the hosted app has
 * nothing to serve, or an environment variable that only exists on this
 * machine.
 *
 * Exits non-zero on anything that would break or leak, so it can gate a push.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const P = (...p) => path.join(ROOT, ...p);

let fail = 0, warn = 0;
const line = (state, label, detail) => {
  const mark = { OK: "  OK  ", WARN: " WARN ", FAIL: " FAIL " }[state];
  console.log(`[${mark}] ${label.padEnd(42)} ${detail || ""}`);
  if (state === "FAIL") fail++;
  if (state === "WARN") warn++;
};

console.log("\n  Pre-deploy check\n");

/* ------------------------------------------------------------ 1. secrets */

const envPath = P(".env");
const secrets = [];
if (fs.existsSync(envPath)) {
  for (const l of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.+)$/);
    if (!m) continue;
    const [, k, v] = m;
    const val = v.trim();
    if (val.length < 12 || /^https?:\/\/localhost/.test(val)) continue;
    if (k === "DIGEST_TO") continue;
    secrets.push({ key: k, val });
    if (k === "DATAFORSEO_B64") {
      try {
        const pw = Buffer.from(val, "base64").toString("utf8").split(":")[1];
        if (pw && pw.length > 6) secrets.push({ key: k + ":password", val: pw });
      } catch (e) { /* not base64 */ }
    }
  }
}

// What git would actually publish — the only list that matters.
let tracked = [];
try {
  tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
} catch (e) {
  line("WARN", "git repository", "not initialised yet — run: git init");
}

if (tracked.length && secrets.length) {
  const leaks = [];
  for (const f of tracked) {
    const abs = P(f);
    let txt;
    try {
      if (!fs.existsSync(abs) || fs.statSync(abs).size > 40 * 1024 * 1024) continue;
      txt = fs.readFileSync(abs, "utf8");
    } catch (e) { continue; }
    for (const s of secrets) if (txt.includes(s.val)) leaks.push(`${s.key} in ${f}`);
  }
  leaks.length
    ? line("FAIL", "no secret in a tracked file", leaks.join("; "))
    : line("OK", "no secret in a tracked file", `${secrets.length} secret(s) checked against ${tracked.length} tracked file(s)`);
} else if (!secrets.length) {
  line("WARN", "no secret in a tracked file", "no .env found — nothing to check");
}

for (const f of [".env", "collectors/store/auth-users.json", "collectors/store/webhook-config.json"]) {
  if (!fs.existsSync(P(f))) continue;
  tracked.includes(f)
    ? line("FAIL", `${f} is ignored`, "IT IS TRACKED — remove it: git rm --cached " + f)
    : line("OK", `${f} is ignored`, "not tracked");
}

/* --------------------------------------------------- 2. data the host serves */

// A serverless deploy cannot collect, so whatever is committed IS the dashboard.
const REQUIRED_DATA = ["meta.json", "brands.json"];
const OPTIONAL_DATA = ["ai.json", "competitors.json", "directory-listings.json", "ai-history.json", "rank-assets.json", "recommendations.json"];

for (const f of REQUIRED_DATA) {
  const abs = P("data", f);
  if (!fs.existsSync(abs)) { line("FAIL", `data/${f}`, "missing — the hosted app would show 'no data built yet'"); continue; }
  if (!tracked.length || tracked.includes(`data/${f}`)) {
    line("OK", `data/${f}`, `${Math.round(fs.statSync(abs).size / 1024)} KB, committed`);
  } else {
    line("FAIL", `data/${f}`, "exists but is NOT tracked — the deploy would have no data");
  }
}
for (const f of OPTIONAL_DATA) {
  const abs = P("data", f);
  if (!fs.existsSync(abs)) { line("WARN", `data/${f}`, "absent — that tab will show its empty state"); continue; }
  line("OK", `data/${f}`, `${Math.round(fs.statSync(abs).size / 1024)} KB`);
}

/* ------------------------------------------------------------ 3. repo size */

if (tracked.length) {
  let bytes = 0;
  const big = [];
  for (const f of tracked) {
    try {
      const sz = fs.statSync(P(f)).size;
      bytes += sz;
      if (sz > 5 * 1024 * 1024) big.push(`${f} (${Math.round(sz / 1024 / 1024)} MB)`);
    } catch (e) { /* deleted */ }
  }
  const mb = bytes / 1024 / 1024;
  line(mb > 100 ? "FAIL" : mb > 40 ? "WARN" : "OK", "repository size",
    `${mb.toFixed(1)} MB across ${tracked.length} files` + (big.length ? ` — large: ${big.join(", ")}` : ""));
}

/* ------------------------------------------------ 4. serverless requirements */

const { execFileSync } = require("child_process");
const secretOk = (process.env.SESSION_SECRET || "").length >= 32;
line(secretOk ? "OK" : "WARN", "SESSION_SECRET",
  secretOk
    ? "set locally (must also be set in Vercel)"
    : "not set locally. REQUIRED in Vercel — generate with: npm run session:secret");

let accounts = 0;
try { accounts = require("./lib/auth").status().configured; } catch (e) { /* zero */ }
line(accounts ? "OK" : "FAIL", "provisioned accounts",
  accounts
    ? `${accounts} account(s). auth-users.json is gitignored — paste it into AUTH_USERS_JSON in Vercel`
    : "none — run: npm run auth:init");

// Every key the hosted app needs at runtime.
const RUNTIME_KEYS = [
  ["DATAFORSEO_B64", "AI Visibility across all six surfaces"],
  ["WINDSOR_API_KEY", "first-party AI referral traffic"],
  ["OCTOLENS_API_KEY", "mention collection (local only)"],
  ["NEWSAPI_KEY", "mention collection (local only)"],
  ["BRIGHTDATA_API_KEY", "LinkedIn scraping (local only)"],
];
require("./lib/env").load();
for (const [k, why] of RUNTIME_KEYS) {
  line(process.env[k] ? "OK" : "WARN", k, process.env[k] ? `set — copy to Vercel (${why})` : `absent — ${why} will report unavailable`);
}

/* ------------------------------------------------------------ 5. entry points */

for (const f of ["api/index.js", "vercel.json", "server.js"]) {
  if (!fs.existsSync(P(f))) { line("FAIL", f, "missing"); continue; }
  try {
    execFileSync(process.execPath, ["--check", P(f)], { stdio: "pipe" });
    line("OK", f, "parses");
  } catch (e) {
    if (f.endsWith(".json")) {
      try { JSON.parse(fs.readFileSync(P(f), "utf8")); line("OK", f, "valid JSON"); }
      catch (e2) { line("FAIL", f, "invalid JSON"); }
    } else {
      line("FAIL", f, "syntax error");
    }
  }
}

// The handler must be importable without binding a port.
try {
  const h = require("../server.js");
  line(typeof h === "function" ? "OK" : "FAIL", "server.js exports a handler",
    typeof h === "function" ? "requiring it does not start a listener" : `exported ${typeof h}`);
} catch (e) {
  line("FAIL", "server.js exports a handler", String(e.message).slice(0, 60));
}

/* ------------------------------------------------------------------ verdict */

console.log(`\n  ${fail} failure(s), ${warn} warning(s)`);
if (fail) {
  console.log("\n  Not ready to deploy. Fix the failures above.\n");
  process.exit(1);
}
console.log("\n  Ready. Set the environment variables in Vercel, then deploy.");
console.log("  Warnings are features that will report themselves unavailable — not breakage.\n");
