#!/usr/bin/env node
/**
 * Emit ONLY the variables Vercel needs, in paste-ready form.
 *
 *   npm run env:vercel                     print them
 *   npm run env:vercel -- --skip=SESSION_SECRET,WINDSOR_API_KEY
 *   npm run env:vercel -- --out            write .env.vercel (gitignored)
 *
 * WHY THIS EXISTS
 * ---------------
 * Pasting the whole .env into Vercel fails, and confusingly:
 *
 *   "A variable with the name SESSION_SECRET already exists for the
 *    targets production and preview"
 *
 * Two separate causes, both easy to hit:
 *
 *   1. Vercel scopes every variable to an ENVIRONMENT — Production, Preview,
 *      Development. Adding a name that already covers one of those targets is
 *      rejected as a duplicate rather than merged. The fix is to EDIT the
 *      existing variable and tick the missing environment, not to add a second.
 *
 *   2. .env holds 27 variables and Vercel needs 6. The other 21 are either
 *      collector credentials that do nothing on a serverless host, or
 *      local-only values — and PORT is reserved outright. Bulk-pasting them
 *      invites exactly the collision above on whichever ones already exist.
 *
 * So this prints the 6, with AUTH_USERS_JSON assembled from the real
 * auth-users.json file (which is gitignored, so a fresh deploy has no accounts
 * and every login would be rejected without it).
 */
const fs = require("fs");
const path = require("path");
const { load } = require("./lib/env");

load();

const ROOT = path.join(__dirname, "..");

/** Exactly what the hosted app reads. Nothing else belongs in Vercel. */
const VERCEL_VARS = [
  { key: "SESSION_SECRET", required: true, why: "Stateless session cookies. Without it nobody stays signed in." },
  { key: "AUTH_USERS_JSON", required: true, why: "Account hashes; auth-users.json is gitignored so a fresh deploy has none.", fromFile: "collectors/store/auth-users.json" },
  { key: "DATAFORSEO_B64", required: false, why: "AI Visibility across all six surfaces." },
  { key: "DATAFORSEO_MAX_PROBE_COST", required: false, why: "Per-probe spend cap." },
  { key: "DATAFORSEO_MIN_BALANCE", required: false, why: "Balance reserve held back." },
  { key: "WINDSOR_API_KEY", required: false, why: "First-party AI referral traffic (GA4)." },
];

const arg = k => {
  const a = process.argv.find(x => x.startsWith(`--${k}=`));
  return a ? a.split("=").slice(1).join("=") : null;
};

const skip = new Set(
  String(arg("skip") || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
);
const writeOut = process.argv.includes("--out");

/** Resolve a value: from the environment, or from a file for AUTH_USERS_JSON. */
function valueFor(v) {
  if (v.fromFile) {
    const p = path.join(ROOT, v.fromFile);
    if (!fs.existsSync(p)) {
      return { value: null, note: `${v.fromFile} not found — run: npm run auth:init` };
    }
    try {
      // Minified to one line: Vercel's value field is single-line, and a
      // pretty-printed JSON blob pasted there is truncated at the first newline.
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      const accounts = Object.keys(parsed.users || {}).length;
      if (!accounts) return { value: null, note: `${v.fromFile} has no accounts — run: npm run auth:init` };
      return { value: JSON.stringify(parsed), note: `${accounts} account(s), minified to one line` };
    } catch (e) {
      return { value: null, note: `${v.fromFile} is not valid JSON` };
    }
  }
  const raw = process.env[v.key];
  if (!raw) return { value: null, note: "not set in .env" };
  return { value: raw, note: null };
}

const rows = [];
const problems = [];

for (const v of VERCEL_VARS) {
  if (skip.has(v.key)) {
    rows.push({ ...v, skipped: true });
    continue;
  }
  const { value, note } = valueFor(v);
  if (!value) {
    if (v.required) problems.push(`${v.key}: ${note}`);
    rows.push({ ...v, value: null, note });
    continue;
  }
  rows.push({ ...v, value, note });
}

/* ------------------------------------------------------------- validation */

/**
 * Vercel rejects a value with: Environment variable "X" is invalid.
 *
 * The cause is almost always an EMPTY value, and the usual way to create one
 * is bulk-pasting .env.example -- 24 of its 30 keys are deliberately blank
 * placeholders. Vercel stores each as a variable with no value, then refuses
 * to deploy. The message names the variable but not the reason, and the first
 * symptom is a DIFFERENT error ("already exists for the targets ...") when you
 * try to add the real value on top.
 *
 * So nothing empty is ever emitted from here, and each value is checked
 * against the constraints Vercel actually enforces.
 */
function validateForVercel(key, value) {
  const problems = [];

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    problems.push("name must match [A-Za-z_][A-Za-z0-9_]*");
  }

  if (value === null || value === undefined || value === "") {
    problems.push("value is EMPTY - Vercel stores the variable, then reports it invalid");
    return problems;
  }

  /* Character checks use char codes rather than escape literals: scripted
   * edits mangled the escapes in this function twice, once splitting a regex
   * across two lines and breaking the whole file. */
  const TAB = String.fromCharCode(9);
  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);

  if (value !== value.trim()) {
    problems.push("value has leading or trailing whitespace");
  }
  if (value.includes(CR) || value.includes(LF)) {
    problems.push("value contains a newline - Vercel truncates at the first one");
  }
  if (Buffer.byteLength(value) > 65536) {
    problems.push("value is " + Buffer.byteLength(value) + " bytes, over the 64KB limit");
  }
  for (const ch of value) {
    const c = ch.codePointAt(0);
    if (c < 32 && ch !== TAB && ch !== LF && ch !== CR) {
      problems.push("value contains control character U+" + c.toString(16).padStart(4, "0"));
      break;
    }
  }

  return problems;
}

/* --------------------------------------------------------------------- output */

// Validate before emitting. An invalid value written into .env.vercel would
// be pasted into Vercel and produce the same error this tool exists to avoid.
for (const r of rows) {
  if (r.skipped || !r.value) continue;
  const bad = validateForVercel(r.key, r.value);
  if (bad.length) {
    r.invalid = bad;
    problems.push(r.key + ": " + bad.join("; "));
  }
}

const emit = rows.filter(r => r.value && !r.skipped && !r.invalid);

if (writeOut) {
  const out = path.join(ROOT, ".env.vercel");
  const body = [
    "# Paste-ready for Vercel -> Settings -> Environment Variables.",
    "# Generated by: npm run env:vercel -- --out",
    "#",
    "# Tick ALL THREE environments (Production, Preview, Development) for each.",
    "# If Vercel says a name already exists, EDIT that variable and add the",
    "# missing environment - do not create a second one.",
    "#",
    "# DELETE THIS FILE AFTER PASTING. It contains live secrets.",
    "",
    ...emit.map(r => `${r.key}=${r.value}`),
    "",
  ].join("\n");
  fs.writeFileSync(out, body, { mode: 0o600 });
  console.log(`\n  written: .env.vercel  (${emit.length} variable(s), gitignored)`);
  console.log("  DELETE IT once pasted — it holds live secrets.\n");
} else {
  console.log("\n  Variables for Vercel — paste these, nothing else\n");
  for (const r of rows) {
    if (r.skipped) {
      console.log(`  -- ${r.key}  SKIPPED (already set in Vercel)`);
      continue;
    }
    if (!r.value) {
      console.log(`  !! ${r.key}  ${r.required ? "REQUIRED but " : ""}${r.note}`);
      continue;
    }
    // Long values are summarised rather than dumped, so a terminal paste of
    // this output does not become the thing that leaks them.
    const shown = r.value.length > 78
      ? `${r.value.slice(0, 40)}…${r.value.slice(-8)}   [${r.value.length} chars — use --out]`
      : r.value;
    console.log(`  ${r.key}=${shown}`);
    if (r.note) console.log(`     ${r.note}`);
  }
  console.log(`\n  ${emit.length} to set. Run with --out to write .env.vercel for copy-paste.\n`);
}

if (problems.length) {
  console.log("  Missing required values:");
  for (const p of problems) console.log(`    ${p}`);
  console.log("");
}

if (process.argv.includes("--cli")) {
  console.log("  Vercel CLI - avoids the dashboard entirely");
  console.log("");
  console.log("    npm i -g vercel && vercel login && vercel link");
  console.log("");
  console.log("  Remove any existing (possibly empty) copy first, then add:");
  console.log("");
  for (const r of emit) {
    for (const envName of ["production", "preview", "development"]) {
      console.log("    vercel env rm " + r.key + " " + envName + " --yes 2>NUL");
    }
  }
  console.log("");
  console.log("  Then add each, ticking all three environments. You will be prompted");
  console.log("  for the value - paste it from .env.vercel:");
  console.log("");
  for (const r of emit) {
    console.log("    vercel env add " + r.key + " production preview development");
  }
  console.log("");
}

console.log("  Vercel notes");
console.log("    * Tick Production, Preview AND Development for each variable.");
console.log('    * "already exists for the targets production and preview" means the');
console.log("      name is set for those environments. EDIT the existing variable and");
console.log("      tick the missing environment; adding a second is rejected.");
console.log("    * Do NOT add PORT — Vercel reserves it, and the hosted app never reads");
console.log("      it (listen() only runs when server.js is executed directly).");
console.log("    * Do NOT add SEARXNG_URL or the collector keys — collectors do not run");
console.log("      on Vercel. Those belong in GitHub Actions secrets.");
console.log("");

process.exit(problems.length ? 1 : 0);
