#!/usr/bin/env node
/**
 * Manage account-backed collection credentials.
 *
 *   npm run social:status
 *   npm run social:login  -- --platform=linkedin --value=<li_at>
 *   npm run social:login  -- --platform=reddit --value=<id>:<secret>
 *   npm run social:logout -- --platform=x
 *
 * THE VALUE IS PASSED ON THE COMMAND LINE ON PURPOSE, AND THAT IS A TRADE-OFF
 * WORTH NAMING: it will land in shell history. The alternative is an
 * interactive prompt, and this project's own history is the argument against
 * that — the two previous account-backed collectors both died on interactive
 * flows that could not run unattended. A flag works in a terminal, in a script
 * and on a private runner.
 *
 * Clear it afterwards if that matters on your machine:
 *   PowerShell:  Clear-History
 *   bash:        history -d $((HISTCMD-1))
 */
const { load } = require("./lib/env");
const social = require("./lib/social-auth");

load();

function arg(k, d) {
  const a = process.argv.find(x => x.startsWith(`--${k}=`));
  return a ? a.split("=").slice(1).join("=") : d;
}

const cmd = process.argv[2] || "status";

function printStatus() {
  const s = social.status();
  console.log("");
  console.log("  Account-backed collection — OPTIONAL, adds coverage on top of the keyless sources");
  console.log("");

  if (!s.available_here) {
    console.log("  [ DISABLED ] " + s.unavailable_reason);
    console.log("");
    return;
  }
  console.log(`  vault: ${s.vault_path}${s.vault_exists ? "" : "  (not created yet)"}`);
  console.log("  encrypted with AES-256-GCM under a key derived from SESSION_SECRET");
  console.log("");

  for (const p of s.platforms) {
    const mark = {
      active: "  OK  ", stale: " STALE", not_configured: "  --  ", unavailable: " N/A  ",
    }[p.state] || p.state;
    console.log(`  [${mark}] ${p.label.padEnd(12)} ${p.credential}`);
    if (p.state === "active") {
      console.log(`            expires ${p.expires_at.slice(0, 10)} (${p.days_left} day(s) left)`);
    } else if (p.reason) {
      console.log(`            ${p.reason}`);
    }
    console.log(`            adds: ${p.what_it_adds}`);
    console.log(`            risk: ${p.risk}`);
    console.log("");
  }
  console.log("  " + s.note);
  console.log("");
}

if (cmd === "status" || process.argv.includes("--status")) {
  printStatus();
} else if (cmd === "login") {
  const platform = arg("platform", null);
  const value = arg("value", null);
  const cadence = parseInt(arg("cadence", ""), 10) || null;
  const account = arg("account", null);

  if (!platform || !social.PLATFORMS[platform]) {
    console.error(`\n  --platform is required. Known: ${Object.keys(social.PLATFORMS).join(", ")}\n`);
    for (const [id, m] of Object.entries(social.PLATFORMS)) {
      console.error(`  ${id.padEnd(10)} ${m.credential}`);
      console.error(`             ${m.how}\n`);
    }
    process.exit(1);
  }
  if (!value) {
    const m = social.PLATFORMS[platform];
    console.error(`\n  --value is required.\n\n  ${m.label}: ${m.credential}\n  ${m.how}\n`);
    console.error(`  ${m.risk}\n`);
    process.exit(1);
  }

  try {
    const r = social.set(platform, value, { cadenceDays: cadence, account });
    console.log(`\n  Stored ${social.PLATFORMS[platform].label} credential.`);
    console.log(`  expires: ${r.expires_at.slice(0, 10)}  (refresh before then — an expired session`);
    console.log(`           returns an EMPTY feed rather than an error, so it would read as "no mentions")`);
    console.log(`  vault:   ${r.vault}\n`);
  } catch (e) {
    console.error(`\n  ${e.message}\n`);
    process.exit(1);
  }
} else if (cmd === "logout") {
  const platform = arg("platform", null);
  if (!platform) { console.error("\n  --platform is required.\n"); process.exit(1); }
  try {
    const r = social.remove(platform);
    console.log(`\n  ${r.removed ? "Removed" : "Nothing stored for"} ${platform}.\n`);
  } catch (e) {
    console.error(`\n  ${e.message}\n`);
    process.exit(1);
  }
} else {
  console.error(`\n  Unknown command "${cmd}". Use: status | login | logout\n`);
  process.exit(1);
}
