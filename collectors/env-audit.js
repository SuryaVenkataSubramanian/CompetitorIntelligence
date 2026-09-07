#!/usr/bin/env node
/**
 * Environment-variable hygiene.
 *
 *   npm run env:audit
 *
 * Answers three questions that get easy to fumble once one project deploys to
 * three different targets:
 *
 *   1. Is any key declared twice? A later assignment silently wins, so a
 *      duplicate is a value you believe you set and did not.
 *   2. Does the code read anything .env.example fails to document, or does the
 *      example document anything the code never reads? Both directions matter:
 *      an undocumented key is one a teammate cannot know to set, and a
 *      documented-but-unread key is noise that invites setting it in the wrong
 *      place.
 *   3. Is anything about to be set on a target that ignores or rejects it?
 *      PORT is reserved on Vercel. SEARXNG_URL points at localhost and is
 *      unreachable from a serverless host. Collector keys do nothing there
 *      because collectors do not run there.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const P = (...p) => path.join(ROOT, ...p);

/** Where each variable belongs, and why. */
const TARGETS = {
  SESSION_SECRET: ["vercel", "Required: stateless session cookies. Without it nobody stays signed in."],
  AUTH_USERS_JSON: ["vercel", "Required: the account hashes, since auth-users.json is gitignored."],

  DATAFORSEO_B64: ["both", "AI Visibility across all six surfaces."],
  DATAFORSEO_LOGIN: ["both", "Alternative to DATAFORSEO_B64 — set one form, not both."],
  DATAFORSEO_PASSWORD: ["both", "Alternative to DATAFORSEO_B64 — set one form, not both."],
  DATAFORSEO_MAX_PROBE_COST: ["both", "Per-probe spend cap."],
  DATAFORSEO_MIN_BALANCE: ["both", "Balance reserve held back."],
  WINDSOR_API_KEY: ["both", "First-party AI referral traffic (GA4)."],

  OCTOLENS_API_KEY: ["actions", "Collector-only. Collectors do not run on Vercel."],
  NEWSAPI_KEY: ["actions", "Collector-only."],
  BRIGHTDATA_API_KEY: ["actions", "Collector-only."],
  DIGEST_TO: ["actions", "Daily digest recipient."],
  SMTP_HOST: ["actions", "Digest delivery."],
  SMTP_PORT: ["actions", "Digest delivery."],
  SMTP_USER: ["actions", "Digest delivery."],
  SMTP_PASS: ["actions", "Digest delivery."],
  SMTP_FROM: ["actions", "Digest delivery."],

  PORT: ["local", "RESERVED on Vercel, and never read there — listen() only runs when server.js is executed directly."],
  SEARXNG_URL: ["local", "A localhost service; unreachable from a serverless host."],
  SERP_PROVIDER: ["local", "Only meaningful alongside a reachable SearXNG."],

  LINKEDIN_LI_AT: ["local", "A personal LinkedIn session cookie. Never set anywhere hosted."],
  X_USERNAME: ["local", "A personal X sign-in. Never set anywhere hosted."],
  X_EMAIL: ["local", "A personal X sign-in. Never set anywhere hosted."],
  X_PASSWORD: ["local", "A personal X sign-in. Never set anywhere hosted."],
  REFRESH_INTERVAL_MS: ["local", "Refresh-loop tuning; the loop is a local long-running process."],
  REFRESH_BRANDS_PER_TICK: ["local", "Refresh-loop tuning."],
  REFRESH_WINDOW_DAYS: ["local", "Refresh-loop tuning."],
  SEARXNG_PORT: ["local", "Port the refresh service health-checks SearXNG on."],

  DEPLOY_MODE: ["optional", "Vercel is auto-detected; needed only to reproduce hosted behaviour locally."],
  SESSION_MODE: ["optional", "Auto-detected; override only for testing."],
};

/** Names Vercel reserves — setting them is rejected or silently ignored. */
const VERCEL_RESERVED = new Set([
  "PORT", "NOW_REGION", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_REGION",
  "AWS_REGION", "AWS_LAMBDA_FUNCTION_NAME", "NODE_ENV", "TZ",
]);

/** Variables supplied by the platform or tooling, not by us. */
const AMBIENT = new RegExp([
  "^(npm_|GITHUB_|RUNNER_)",
  "^(CI|HOME|PATH|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|COMSPEC|OSTYPE|USER|USERNAME|HOMEDRIVE|PATHEXT|DISPLAY|TERM_PROGRAM|FORCE_COLOR|DEBUG)$",
  // Detected or set by this project rather than configured by a user:
  // NETLIFY and VERCEL are platform markers, PYTHONPATH is set for the
  // SearXNG pwd shim, PROGRAMFILES is a Windows path lookup.
  "^(NETLIFY|PYTHONPATH|PROGRAMFILES|CLAUDECODE)$",
].join("|"));

function keysOf(file) {
  if (!fs.existsSync(file)) return null;
  const out = [];
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out.push({ key: m[1], value: m[2], line: i + 1 });
  });
  return out;
}

let fail = 0, warn = 0;
function say(state, msg) {
  const mark = { FAIL: "[FAIL]", WARN: "[WARN]", OK: "[ OK ]" }[state];
  console.log(`  ${mark} ${msg}`);
  if (state === "FAIL") fail++;
  if (state === "WARN") warn++;
}

console.log("\n  Environment variable audit\n");

/* ----------------------------------------------------------- 1. duplicates */

for (const file of [".env", ".env.example"]) {
  const ks = keysOf(P(file));
  if (!ks) { say("WARN", `${file} not found`); continue; }
  const seen = new Map();
  const dupes = [];
  for (const k of ks) {
    if (seen.has(k.key)) dupes.push(`${k.key} (lines ${seen.get(k.key)} and ${k.line})`);
    else seen.set(k.key, k.line);
  }
  if (dupes.length) {
    say("FAIL", `${file}: duplicate key(s) — the later assignment silently wins: ${dupes.join(", ")}`);
  } else {
    say("OK", `${file}: ${seen.size} unique key(s), no duplicates`);
  }
}

/* ------------------------------------ 2. documented vs actually read by code */

// Discovered from source rather than maintained as a list, so it cannot drift.
const readByCode = new Set();
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    /* Skip vendored and generated trees. collectors/python/.venv in
     * particular bundles Playwright, whose JS reads ~70 PLAYWRIGHT_* and
     * PWTEST_* variables — scanning it drowned this report in third-party
     * noise and hid three real project variables. Any dot-directory is
     * skipped for the same reason. */
    if (["node_modules", ".git", "vendor", "data", "dist", "build"].includes(e.name)) continue;
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!p.endsWith(".js") && !p.endsWith(".yml")) continue;
    const t = fs.readFileSync(p, "utf8");
    /* Match the FULL identifier, including mixed case. Matching only
     * [A-Z0-9_]+ truncated `process.env.ProgramFiles` to the single letter
     * "P" and reported that as an undocumented variable. Mixed-case names are
     * platform-provided (ProgramFiles, SystemRoot), so only ALL_CAPS names —
     * the convention for configuration — are collected. */
    for (const m of t.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)) {
      if (/^[A-Z][A-Z0-9_]*$/.test(m[1])) readByCode.add(m[1]);
    }
    // Bracket form, e.g. process.env[someName] with a literal inside.
    for (const m of t.matchAll(/process\.env\[\s*["'][A-Z0-9_]+["']\s*\]/g)) {
      const k = m[0].match(/[A-Z0-9_]{2,}/g);
      if (k) readByCode.add(k[k.length - 1]);
    }
  }
})(ROOT);

const documented = new Set((keysOf(P(".env.example")) || []).map(k => k.key));

const undocumented = [...readByCode]
  .filter(k => !documented.has(k) && !VERCEL_RESERVED.has(k) && !AMBIENT.test(k))
  .sort();
if (undocumented.length) {
  say("WARN", `read by code but absent from .env.example: ${undocumented.join(", ")}`);
} else {
  say("OK", "every variable the code reads is documented in .env.example");
}

const unread = [...documented].filter(k => !readByCode.has(k)).sort();
if (unread.length) {
  say("WARN", `documented but never read by code: ${unread.join(", ")}`);
} else {
  say("OK", "every documented variable is read somewhere in the code");
}

/* --------------------------------------------------- 3. target correctness */

const local = keysOf(P(".env")) || [];
const set = new Map(local.filter(k => k.value.trim()).map(k => [k.key, k.value.trim()]));

const reserved = [...set.keys()].filter(k => VERCEL_RESERVED.has(k)).sort();
if (reserved.length) {
  say("WARN", `set locally but RESERVED on Vercel — do not add there: ${reserved.join(", ")}`);
} else {
  say("OK", "nothing set locally that Vercel reserves");
}

// The one genuine either/or in this configuration.
if (set.has("DATAFORSEO_B64") && (set.has("DATAFORSEO_LOGIN") || set.has("DATAFORSEO_PASSWORD"))) {
  say("WARN", "DATAFORSEO_B64 and DATAFORSEO_LOGIN/PASSWORD are both set — B64 wins, so the pair is dead config. Keep one form.");
} else {
  say("OK", "the DataForSEO credential is supplied in exactly one form");
}

// A localhost URL on a serverless host resolves to nothing.
const localhostKeys = [...set.entries()]
  .filter(([, v]) => /localhost|127\.0\.0\.1/.test(v))
  .map(([k]) => k);
if (localhostKeys.length) {
  say("OK", `points at localhost, so local-only by nature: ${localhostKeys.join(", ")}`);
}

/* ---------------------------------------------------- the per-target listing */

const LABELS = {
  vercel: "VERCEL — required, the app will not serve without these",
  both: "VERCEL and GITHUB ACTIONS — set in both",
  actions: "GITHUB ACTIONS only — collectors never run on Vercel",
  local: "LOCAL only — do NOT set these in Vercel",
  optional: "OPTIONAL — leave blank unless testing",
};

console.log("\n  What to set where\n");
for (const target of ["vercel", "both", "actions", "local", "optional"]) {
  const keys = Object.keys(TARGETS).filter(k => TARGETS[k][0] === target);
  if (!keys.length) continue;
  console.log(`  ${LABELS[target]}`);
  for (const k of keys) {
    console.log(`    ${set.has(k) ? "*" : " "} ${k.padEnd(28)} ${TARGETS[k][1]}`);
  }
  console.log("");
}
console.log("  * = a non-empty value exists in your local .env\n");

console.log(`  ${fail} failure(s), ${warn} warning(s)\n`);
process.exit(fail ? 1 : 0);
