/**
 * Account-backed collection: an opt-in credential vault with a refresh cadence.
 *
 * WHY THIS IS CAREFUL RATHER THAN CONVENIENT
 * ------------------------------------------
 * This project has tried account-backed collection TWICE and both attempts had
 * to be deleted:
 *
 *   adapters/x_twikit.js   drove a real X account with a username and password.
 *                          It never collected once.
 *   adapters/linkedin.js   needed a li_at session cookie. Dormant from the day
 *                          it was written.
 *
 * They failed for the same three reasons, and every one of them is a design
 * constraint here rather than a thing to try harder at:
 *
 *   1. A personal login CANNOT go to a hosted deployment. Putting a colleague's
 *      LinkedIn cookie in a Vercel env var makes every deploy log and every
 *      person with dashboard access a custodian of their account.
 *   2. Interactive flows die on CAPTCHA and 2FA. Not sometimes — reliably, and
 *      at the worst moment, which is unattended at 3am.
 *   3. They FAILED SILENTLY. A dead session returns an empty list, not an
 *      error, so the channel reported zero mentions and looked healthy.
 *
 * So the rules this file enforces:
 *
 *   LOCAL ONLY          refuses to load on a serverless host, full stop.
 *   NEVER IN GIT        the vault lives outside the repo, in the OS user
 *                       profile, and .gitignore is belt-and-braces on top.
 *   ENCRYPTED AT REST   AES-256-GCM under a key derived from SESSION_SECRET.
 *                       Not a serious defence against someone with the machine,
 *                       but it stops a cookie appearing in a backup or a
 *                       screen-share in plaintext.
 *   NEVER SILENT        every credential has an explicit expiry and a refresh
 *                       cadence. Past it, the channel reports STALE — it does
 *                       not report zero. That is the whole point.
 *   ALWAYS OPTIONAL     nothing here is required. Every channel has a keyless
 *                       route; this only ever ADDS coverage.
 *   TAGGED PROVENANCE   records collected this way are marked auth_backed so a
 *                       reader can tell which account saw them.
 *
 * WHAT THE RESEARCH SAYS, AND WHY THE CADENCE IS SHORT
 * ---------------------------------------------------
 * Surveying the open-source landscape (Sept 2026): every maintained LinkedIn
 * scraper wants a session file, and the most popular one — joeyism/linkedin_scraper,
 * ~2.5k stars — is now marked inactive. On X, snscrape/Twint/ntscraper are dead;
 * Scweet, twscrape, Twikit and Tweety work but "all need residential proxies and
 * a logged-in account for full data, and all break every two to four weeks when
 * X rotates its guest tokens and GraphQL identifiers."
 *
 * Two to four weeks is the real number, so the default cadence is 14 days and
 * the vault nags before it expires rather than after.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const deployment = require("./deployment");

/* The vault lives OUTSIDE the repository. A file inside it is one `git add -A`
 * away from being published, and this repository is public. */
const VAULT_DIR = path.join(os.homedir(), ".d360-competitive-intel");
const VAULT = path.join(VAULT_DIR, "social-auth.enc");

/** Platforms this can hold credentials for, and what each is actually worth. */
const PLATFORMS = {
  linkedin: {
    label: "LinkedIn",
    credential: "li_at session cookie",
    how: "Sign in to LinkedIn in a browser, open DevTools > Application > Cookies > linkedin.com, copy the value of `li_at`.",
    default_cadence_days: 14,
    adds:
      "Post reactions, comment threads and the commenter list — none of which appear in a Google SERP snippet. " +
      "It does NOT replace the SerpAPI route, which already finds the posts themselves.",
    risk:
      "LinkedIn suspends accounts for automated access. Use a secondary account you can afford to lose, " +
      "never a personal or executive one.",
  },
  x: {
    label: "X / Twitter",
    credential: "auth_token cookie",
    how: "Sign in to x.com in a browser, open DevTools > Application > Cookies > x.com, copy the value of `auth_token`.",
    default_cadence_days: 14,
    adds:
      "Full-fidelity search and replies beyond what twitterapi.io returns on an exhausted plan.",
    risk:
      "X rotates guest tokens and GraphQL identifiers every 2-4 weeks; expect this to break on that cadence. " +
      "Rate limits are per-account and a burst gets the account locked.",
  },
  reddit: {
    label: "Reddit",
    credential: "OAuth script-app client id and secret",
    how: "Create a 'script' app at reddit.com/prefs/apps. This is a FIRST-PARTY API credential, not a scraped session — prefer it over the others.",
    default_cadence_days: 90,
    adds:
      "Restores Reddit after the May 2026 block on anonymous access. Currently the keyless RSS route " +
      "self-disables for 24h on a 403, so this is the difference between a real Reddit channel and none.",
    risk: "Low. This is a supported API with published rate limits.",
  },
};

/* ------------------------------------------------------------- encryption */

function keyFor() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET is not set. The vault is encrypted with a key derived from it, so it cannot be " +
      "opened or created without one. Generate: npm run session:secret"
    );
  }
  // scrypt rather than a raw hash: the secret is a config value, not a password,
  // but the cost is paid once per process and it removes a class of shortcut.
  return crypto.scryptSync(secret, "d360-social-auth:v1", 32);
}

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyFor(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

function decrypt(b64) {
  const raw = Buffer.from(b64, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", keyFor(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
}

/* ----------------------------------------------------------------- guards */

/**
 * The single most important function here.
 *
 * A serverless deployment must never hold a personal session cookie: its env
 * vars are readable by anyone with project access, they appear in build logs,
 * and the filesystem is shared with nothing durable anyway. This refuses rather
 * than degrading, because degrading is how a credential ends up somewhere it
 * should not be.
 */
function availableHere() {
  if (deployment.isServerless()) {
    return {
      ok: false,
      reason:
        "Account-backed collection is disabled on a hosted deployment by design. A personal session " +
        "cookie in a Vercel env var is readable by everyone with project access and appears in build " +
        "logs. Run account-backed collection locally or on a private runner, and let the hosted app " +
        "read the results.",
    };
  }
  return { ok: true, reason: null };
}

/* ------------------------------------------------------------------ vault */

function readVault() {
  const here = availableHere();
  if (!here.ok) return { ok: false, reason: here.reason, credentials: {} };
  if (!fs.existsSync(VAULT)) return { ok: true, credentials: {}, exists: false };
  try {
    return { ok: true, exists: true, credentials: decrypt(fs.readFileSync(VAULT, "utf8")) };
  } catch (e) {
    return {
      ok: false,
      exists: true,
      credentials: {},
      reason:
        "The vault exists but could not be decrypted: " + String(e.message || e) +
        ". The usual cause is a changed SESSION_SECRET — rotating it makes every stored credential " +
        "unreadable. Delete " + VAULT + " and re-add them.",
    };
  }
}

function writeVault(creds) {
  const here = availableHere();
  if (!here.ok) throw new Error(here.reason);
  fs.mkdirSync(VAULT_DIR, { recursive: true });
  fs.writeFileSync(VAULT, encrypt(creds), { mode: 0o600 });
  return VAULT;
}

/**
 * Store a credential.
 * The expiry is recorded at write time, so staleness is a property of the
 * record rather than something a caller has to remember to compute.
 */
function set(platform, value, { cadenceDays = null, note = null, account = null } = {}) {
  const meta = PLATFORMS[platform];
  if (!meta) throw new Error(`Unknown platform "${platform}". Known: ${Object.keys(PLATFORMS).join(", ")}`);
  if (!value || String(value).trim().length < 8) {
    throw new Error("That does not look like a credential (under 8 characters).");
  }

  const v = readVault();
  if (!v.ok) throw new Error(v.reason);

  const days = cadenceDays || meta.default_cadence_days;
  const creds = v.credentials;
  creds[platform] = {
    value: String(value).trim(),
    account: account || null,
    note: note || null,
    stored_at: new Date().toISOString(),
    cadence_days: days,
    expires_at: new Date(Date.now() + days * 864e5).toISOString(),
  };
  const at = writeVault(creds);
  return { ok: true, platform, expires_at: creds[platform].expires_at, vault: at };
}

function remove(platform) {
  const v = readVault();
  if (!v.ok) throw new Error(v.reason);
  if (!v.credentials[platform]) return { ok: true, removed: false };
  delete v.credentials[platform];
  writeVault(v.credentials);
  return { ok: true, removed: true };
}

/**
 * Fetch a usable credential, or explain why there is not one.
 *
 * NEVER returns an expired credential. A stale LinkedIn cookie does not error —
 * it returns an empty feed — so a collector that used one would report "no
 * mentions this week" and look healthy. That exact failure is why the two
 * previous attempts were deleted, so expiry is enforced HERE, once, rather than
 * trusted to every caller.
 */
function get(platform) {
  const v = readVault();
  if (!v.ok) return { ok: false, state: "unavailable", reason: v.reason };

  const c = v.credentials[platform];
  if (!c) {
    const meta = PLATFORMS[platform] || {};
    return {
      ok: false,
      state: "not_configured",
      reason: `No ${meta.label || platform} credential stored. This is optional — the keyless route still runs.`,
      how_to_enable: `npm run social:login -- --platform=${platform}`,
    };
  }
  if (Date.parse(c.expires_at) <= Date.now()) {
    return {
      ok: false,
      state: "stale",
      stored_at: c.stored_at,
      expires_at: c.expires_at,
      reason:
        `The ${PLATFORMS[platform].label} credential expired on ${c.expires_at.slice(0, 10)}. It is NOT being ` +
        `used: an expired session returns an empty feed rather than an error, which would show as "no mentions" ` +
        `and look healthy. Refresh it: npm run social:login -- --platform=${platform}`,
    };
  }
  return {
    ok: true,
    state: "active",
    value: c.value,
    account: c.account,
    expires_at: c.expires_at,
    days_left: Math.floor((Date.parse(c.expires_at) - Date.now()) / 864e5),
  };
}

/**
 * What the dashboard and the health check should show.
 * Deliberately returns NO credential values — only state.
 */
function status() {
  const here = availableHere();
  const v = readVault();
  const out = [];

  for (const [id, meta] of Object.entries(PLATFORMS)) {
    const g = here.ok ? get(id) : { ok: false, state: "unavailable", reason: here.reason };
    out.push({
      platform: id,
      label: meta.label,
      credential: meta.credential,
      state: g.state,
      active: g.state === "active",
      days_left: g.days_left ?? null,
      expires_at: g.expires_at || null,
      account: g.account || null,
      reason: g.reason || null,
      what_it_adds: meta.adds,
      risk: meta.risk,
      how_to_enable: `npm run social:login -- --platform=${id}`,
    });
  }

  return {
    available_here: here.ok,
    unavailable_reason: here.reason,
    vault_path: here.ok ? VAULT : null,
    vault_exists: !!v.exists,
    // Said out loud because the whole feature is opt-in and easily mistaken for
    // a requirement.
    note:
      "Account-backed collection is OPTIONAL and adds coverage on top of the keyless sources. No channel " +
      "depends on it: LinkedIn is served by SerpAPI, X by twitterapi.io, and Reddit by RSS when Reddit " +
      "allows it. A stale credential reports stale and is not used.",
    platforms: out,
  };
}

/** Provenance stamp for a record collected with an account. */
function provenance(platform) {
  const g = get(platform);
  return {
    auth_backed: true,
    auth_platform: platform,
    auth_account: g.account || null,
    // The value is NEVER included. This is the whole record a mention carries.
    auth_note: `Collected using a stored ${PLATFORMS[platform].label} session rather than an anonymous route.`,
  };
}

module.exports = {
  PLATFORMS, VAULT, VAULT_DIR,
  availableHere, status, get, set, remove, provenance,
};
