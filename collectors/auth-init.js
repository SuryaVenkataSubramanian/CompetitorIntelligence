/**
 * Provision the four allow-listed accounts.  npm run auth:init [-- --reset]
 *
 * Prints each generated password ONCE. Only a scrypt hash reaches disk, so there
 * is no recovery path — losing a password means re-running with --reset.
 */
const { initUsers, ALLOWED_EMAILS, USERS_FILE } = require("./lib/auth");

const reset = process.argv.includes("--reset");
const issued = initUsers({ reset });

console.log(`\n${reset ? "RESET" : "PROVISIONED"} ${ALLOWED_EMAILS.length} account(s)\n`);
console.log("  " + "email".padEnd(42) + "password".padEnd(22) + "status");
console.log("  " + "-".repeat(42 + 22 + 20));
for (const u of issued) {
  console.log("  " + u.email.padEnd(42) + String(u.password || "(unchanged)").padEnd(22) + u.status);
}
console.log(`
  Hashes only (scrypt N=16384, per-user salt) are stored in:
    ${USERS_FILE}

  These passwords are shown ONCE and are not recoverable. Distribute them now.
  To rotate:  npm run auth:init -- --reset
`);
