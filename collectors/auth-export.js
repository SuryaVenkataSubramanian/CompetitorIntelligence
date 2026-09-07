#!/usr/bin/env node
/**
 * Export the provisioned accounts to a committable file, so a deployment needs
 * no auth configuration of its own.
 *
 *   npm run auth:export          write config/accounts.json
 *   npm run auth:export -- --check   report only, change nothing
 *
 * WHY
 * ---
 * collectors/store/auth-users.json is gitignored, so a fresh deploy has no
 * accounts and every login is rejected. The alternative was pasting the file
 * into an AUTH_USERS_JSON environment variable in Vercel — one more piece of
 * dashboard state to get wrong, and the source of two confusing deploy errors
 * already.
 *
 * This writes the same accounts to config/accounts.json, which IS committed.
 * The app then finds them with no environment variable at all.
 *
 * WHAT GETS PUBLISHED, AND WHAT DOES NOT
 * --------------------------------------
 * Only what authentication actually needs:
 *
 *     email, salt, hash
 *
 * Deliberately excluded: created_at, last_login and login_count. Those are
 * runtime bookkeeping, they change on every sign-in (which would make the file
 * churn in git), and publishing who logged in when is needless disclosure.
 *
 * NO PASSWORD IS EXPORTED — none is stored anywhere. A hash is scrypt with
 * N=16384 over a 16-character random password drawn from a 32-symbol alphabet,
 * about 80 bits of entropy. Reversing that is not a practical attack.
 *
 * THE ONE THING TO GET RIGHT
 * --------------------------
 * A published hash is safe only while SESSION_SECRET is not. If both were
 * public, anyone could sign their own session cookie and skip the login
 * entirely. So SESSION_SECRET must stay an environment variable, and this
 * script refuses to pretend otherwise.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const STORE = path.join(ROOT, "collectors", "store", "auth-users.json");
const OUT = path.join(ROOT, "config", "accounts.json");

const checkOnly = process.argv.includes("--check");

function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch (e) { return null; }
}

/** Is the GitHub remote public? A published hash is a different risk if so. */
function repoVisibility() {
  let url = "";
  try { url = execSync("git remote get-url origin", { cwd: ROOT, encoding: "utf8" }).trim(); }
  catch (e) { return { known: false, note: "no git remote configured" }; }

  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/i);
  if (!m) return { known: false, note: `remote is not GitHub: ${url}` };
  return { known: false, owner: m[1], repo: m[2], note: "check visibility at github.com/" + m[1] + "/" + m[2] + "/settings" };
}

(function main() {
  const store = readStore();
  if (!store || !store.users || !Object.keys(store.users).length) {
    console.error("\n  No provisioned accounts found at collectors/store/auth-users.json");
    console.error("  Run: npm run auth:init\n");
    process.exit(1);
  }

  const emails = Object.keys(store.users);
  const accounts = {};
  for (const email of emails) {
    const u = store.users[email];
    if (!u || !u.salt || !u.hash) {
      console.error(`  ! ${email} has no salt/hash — skipped`);
      continue;
    }
    // Only the three fields authentication needs.
    accounts[email] = { email: u.email || email, salt: u.salt, hash: u.hash };
  }

  const payload = {
    _comment: [
      "Provisioned accounts, committed so a deployment needs no auth configuration.",
      "",
      "Contains ONLY email, salt and scrypt hash. No password is stored here or",
      "anywhere else - `npm run auth:init` prints each one once and keeps only the",
      "hash. Runtime bookkeeping (last_login, login_count) is deliberately absent:",
      "it would churn this file on every sign-in and disclose who logged in when.",
      "",
      "A hash here is safe. A SESSION_SECRET here would NOT be: with both public,",
      "anyone could sign their own session cookie and bypass the login. Keep",
      "SESSION_SECRET an environment variable.",
      "",
      "Regenerate with: npm run auth:export",
      "Add or rotate an account: npm run auth:init, then re-export.",
    ],
    exported_at: new Date().toISOString(),
    account_count: Object.keys(accounts).length,
    accounts,
  };

  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
  const next = JSON.stringify(payload, null, 2) + "\n";

  // Compare only the accounts, so a re-run with no account change is a no-op
  // rather than a commit that only moves the timestamp.
  let unchanged = false;
  if (existing) {
    try {
      const prev = JSON.parse(existing);
      unchanged = JSON.stringify(prev.accounts) === JSON.stringify(accounts);
    } catch (e) { /* treat as changed */ }
  }

  console.log(`\n  ${Object.keys(accounts).length} account(s) ready to commit:\n`);
  for (const email of Object.keys(accounts)) {
    console.log(`    ${email.padEnd(38)} salt ${accounts[email].salt.length} chars, hash ${accounts[email].hash.length} chars`);
  }

  const vis = repoVisibility();
  console.log("");
  console.log("  Before committing this, confirm the repository is PRIVATE.");
  console.log("  " + vis.note);
  console.log("");
  console.log("  A public repo would publish four colleagues' email addresses and their");
  console.log("  password hashes. The hashes are not crackable in practice, but there is");
  console.log("  no upside to publishing them and it would fail any security review.");
  console.log("");

  if (checkOnly) {
    console.log(`  --check: nothing written. ${unchanged ? "config/accounts.json is already current." : "config/accounts.json would change."}\n`);
    process.exit(0);
  }

  if (unchanged) {
    console.log("  config/accounts.json is already current — not rewritten.\n");
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, next);
  console.log(`  written: config/accounts.json`);
  console.log(`  Commit it, then AUTH_USERS_JSON is no longer needed in Vercel.\n`);
})();
