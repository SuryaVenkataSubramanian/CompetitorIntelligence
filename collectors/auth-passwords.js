#!/usr/bin/env node
/**
 * Show the passwords this deployment accepts.
 *
 *   npm run auth:passwords
 *
 * This is a READ, not a provisioning step. Nothing is generated, written or
 * changed — the passwords are a pure function of SESSION_SECRET, so this
 * recomputes what the running app will already accept.
 *
 * WHY IT EXISTS AT ALL
 * --------------------
 * Only to bootstrap: someone has to know a password before the first sign-in.
 * After that, the same list is on the Settings tab inside the app, so sharing
 * with the team happens online rather than over a terminal.
 *
 * THE SECRET MUST MATCH
 * ---------------------
 * These are only the deployment's passwords if the SESSION_SECRET here is the
 * one set on the host. The fingerprint below is printed for exactly that
 * comparison — the same value appears on the Settings tab and in /api/status,
 * so a mismatch is visible instead of being inferred from a failed login.
 */
const { load } = require("./lib/env");
const derived = require("./lib/derived-auth");
const auth = require("./lib/auth");

load();

if (!derived.available()) {
  console.error("\n  SESSION_SECRET is not set (or is under 32 characters), so there are");
  console.error("  no derived passwords to show.");
  console.error("\n  Generate one with:  npm run session:secret");
  console.error("  Add it to .env, and to the host's environment variables.\n");
  process.exit(1);
}

const emails = auth.ALLOWED_EMAILS || [];
const rows = derived.allPasswords(emails);
const fp = derived.secretFingerprint();

console.log("\n  Sign-in credentials for this deployment\n");
console.log("  " + "EMAIL".padEnd(40) + "PASSWORD");
console.log("  " + "-".repeat(40) + "-".repeat(19));
for (const r of rows) {
  console.log("  " + r.email.padEnd(40) + r.password);
}

console.log("");
console.log("  Secret fingerprint: " + fp);
console.log("  These are the deployment's passwords only if the same fingerprint appears");
console.log("  on the Settings tab of the hosted app. If it differs, the host is running");
console.log("  a different SESSION_SECRET and will accept a different set.");
console.log("");
console.log("  Nothing was generated or written. Derived from SESSION_SECRET on the fly,");
console.log("  which is why a fresh deploy needs no provisioning step.");
console.log("");
console.log("  Rotating SESSION_SECRET changes every password at once and signs everyone");
console.log("  out. There is no per-user rotation: that is the cost of storing nothing.");
console.log("");
