/**
 * Authentication: an allow-list of four accounts, each with a generated password.
 *
 * SECURITY DECISIONS, and why each one is what it is:
 *
 * 1. PASSWORDS ARE NEVER STORED. Only a scrypt hash + per-user random salt goes
 *    to disk. scrypt (built into node:crypto, so no dependency) is memory-hard,
 *    which is what makes an offline attack on a leaked file expensive. A plain
 *    SHA-256 would not be.
 *
 * 2. GENERATED ONCE, SHOWN ONCE. `npm run auth:init` prints each password to the
 *    terminal and writes only the hash. There is no recovery path by design —
 *    losing one means regenerating it, which is the correct trade for a tool that
 *    should not hold recoverable credentials.
 *
 * 3. CONSTANT-TIME COMPARISON via timingSafeEqual, so response timing cannot be
 *    used to narrow down a hash.
 *
 * 4. SESSIONS ARE OPAQUE RANDOM TOKENS held server-side, not signed claims in the
 *    cookie. That means logout and revocation actually work, and the cookie
 *    carries no user data to tamper with.
 *
 * 5. THE ALLOW-LIST IS THE AUTHORITY. An email outside it can never authenticate,
 *    even if a stale hash for it somehow existed in the store.
 *
 * 6. LOGIN IS RATE-LIMITED per email+IP, because four known usernames on a
 *    reachable port is exactly the shape a credential-stuffing attempt likes.
 */
const crypto = require("crypto");
const fs = require("fs");
const session = require("./session");
const path = require("path");

const STORE_DIR = path.join(__dirname, "..", "store");
const USERS_FILE = path.join(STORE_DIR, "auth-users.json");

/** The only accounts that may ever authenticate. */
const ALLOWED_EMAILS = [
  "darshan.sureshkumar@kovai.co",
  "sunil.krishna@kovai.co",
  "iyyappan.lakshmipathyrajan@kovai.co",
  "jubina.prabhakaran@kovai.co",
];

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // 12 hours
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

/* ------------------------------------------------------------ persistence */

/**
 * The provisioned accounts.
 *
 * The file is gitignored — it holds scrypt hashes and per-user salts — so a
 * fresh deploy has none. AUTH_USERS_JSON carries the same JSON for hosts with
 * no persistent disk; the file wins locally so `auth:init` behaves normally.
 *
 * Note what is and is not in there: hashes and salts, never a password. Putting
 * this in an environment variable exposes no more than the file does.
 */
/** Where the accounts came from, for /api/status and the deploy check. */
let accountSource = "none";

/**
 * The provisioned accounts, resolved in a deliberate order:
 *
 *   1. collectors/store/auth-users.json  the local, writable store. Wins so
 *      `auth:init` behaves normally on a developer machine.
 *   2. AUTH_USERS_JSON                   an environment variable, for hosts
 *      with no persistent disk that prefer dashboard configuration.
 *   3. config/accounts.json              COMMITTED to the repository, so a
 *      deployment needs no auth configuration at all.
 *
 * Order matters: local file first means exporting to the committed file never
 * shadows a freshly provisioned account, and the env variable still overrides
 * the committed copy if someone wants to rotate without a redeploy.
 *
 * Every source carries only email, salt and scrypt hash. No password exists in
 * any of them.
 */
function readUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const j = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
      if (j && j.users && Object.keys(j.users).length) {
        accountSource = "local store (collectors/store/auth-users.json)";
        return j;
      }
    }
  } catch (e) { /* fall through */ }

  const inline = process.env.AUTH_USERS_JSON;
  if (inline) {
    try {
      const parsed = JSON.parse(inline);
      if (parsed && parsed.users && Object.keys(parsed.users).length) {
        accountSource = "AUTH_USERS_JSON environment variable";
        return parsed;
      }
    } catch (e) {
      // A malformed value must not read as "no accounts", which would look
      // like a wrong password to every user rather than a config error.
      console.error("AUTH_USERS_JSON is set but is not valid JSON — ignoring it.");
    }
  }

  /* The committed fallback. This is what removes the need for any deployment
   * configuration: the hashes travel with the code. Safe only because
   * SESSION_SECRET does NOT — with both public, a session cookie could be
   * forged and the login skipped entirely. */
  try {
    const p = path.join(__dirname, "..", "..", "config", "accounts.json");
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      const accounts = j && j.accounts;
      if (accounts && Object.keys(accounts).length) {
        accountSource = "config/accounts.json (committed)";
        // Normalised to the store's shape so every caller sees one structure.
        return { users: accounts };
      }
    }
  } catch (e) { /* fall through to no accounts */ }

  accountSource = "none";
  return { users: {} };
}

/** Which source the current accounts came from. */
function usersSource() {
  readUsers();
  return accountSource;
}

function writeUsers(obj) {
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(obj, null, 2), { mode: 0o600 });
  } catch (e) {
    /* Read-only filesystem on a serverless host. Only bookkeeping (last_login,
     * login_count) is written during a login, so losing it must not fail the
     * login itself. Provisioning still requires a writable disk, which is why
     * `auth:init` is a local command. */
    if (!require("./deployment").isServerless()) throw e;
  }
}

/* ---------------------------------------------------------------- hashing */

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, s, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    // scrypt's default maxmem is too small for N=16384; raise it explicitly
    // rather than weakening the work factor.
    maxmem: 64 * 1024 * 1024,
  });
  return { salt: s, hash: derived.toString("hex") };
}

function verifyPassword(password, salt, expectedHex) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(expectedHex, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Readable but high-entropy password: 4 groups of 4 from a 32-char alphabet with
 * look-alikes (0/O, 1/l/I) removed. ~80 bits — strong, and typable without
 * transcription errors, which matters when it is delivered by hand.
 */
function generatePassword() {
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let s = "";
    for (let i = 0; i < 4; i++) {
      s += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
    }
    groups.push(s);
  }
  return groups.join("-");
}

/* -------------------------------------------------------------- accounts */

/**
 * Create or reset every allow-listed account.
 * Returns the plaintext passwords ONCE, for the operator to distribute. They are
 * not persisted anywhere.
 */
function initUsers({ reset = false } = {}) {
  const store = readUsers();
  store.users = store.users || {};
  const issued = [];

  for (const email of ALLOWED_EMAILS) {
    if (store.users[email] && !reset) {
      issued.push({ email, password: null, status: "existing (unchanged)" });
      continue;
    }
    const password = generatePassword();
    const { salt, hash } = hashPassword(password);
    store.users[email] = {
      email,
      salt,
      hash,
      created_at: new Date().toISOString(),
      last_login: null,
      login_count: 0,
    };
    issued.push({ email, password, status: reset ? "reset" : "created" });
  }

  // Drop any account no longer on the allow-list.
  for (const email of Object.keys(store.users)) {
    if (!ALLOWED_EMAILS.includes(email)) delete store.users[email];
  }

  store.updated_at = new Date().toISOString();
  writeUsers(store);
  return issued;
}

/* -------------------------------------------------------------- sessions */

const sessions = new Map();      // token -> { email, created, expires }
const attempts = new Map();      // key -> { count, first, lockedUntil }

function attemptKey(email, ip) {
  return `${String(email || "").toLowerCase()}|${ip || "?"}`;
}

function isLockedOut(email, ip) {
  const a = attempts.get(attemptKey(email, ip));
  if (!a) return false;
  if (a.lockedUntil && Date.now() < a.lockedUntil) {
    return Math.ceil((a.lockedUntil - Date.now()) / 1000);
  }
  return false;
}

function recordFailure(email, ip) {
  const k = attemptKey(email, ip);
  const a = attempts.get(k) || { count: 0, first: Date.now(), lockedUntil: 0 };
  a.count++;
  if (a.count >= MAX_ATTEMPTS) {
    a.lockedUntil = Date.now() + LOCKOUT_MS;
    a.count = 0;
  }
  attempts.set(k, a);
}

function clearFailures(email, ip) {
  attempts.delete(attemptKey(email, ip));
}

function login(email, password, ip) {
  const e = String(email || "").trim().toLowerCase();

  // The allow-list is checked FIRST and is the authority.
  if (!ALLOWED_EMAILS.includes(e)) {
    // Same generic message as a wrong password, so this cannot be used to
    // enumerate which addresses are provisioned.
    return { ok: false, error: "Invalid email or password." };
  }

  const locked = isLockedOut(e, ip);
  if (locked) {
    return { ok: false, error: `Too many attempts. Try again in ${Math.ceil(locked / 60)} minute(s).` };
  }

  const store = readUsers();
  const u = store.users && store.users[e];
  if (!u) {
    return { ok: false, error: "No password has been generated yet. Run: npm run auth:init" };
  }

  if (!password || !verifyPassword(password, u.salt, u.hash)) {
    recordFailure(e, ip);
    return { ok: false, error: "Invalid email or password." };
  }

  clearFailures(e, ip);
  const now = Date.now();

  /* Serverless hosts give every request a possibly-new process, so an
   * in-memory session map would log everyone out at each cold start. There the
   * token is HMAC-signed and self-describing instead; see lib/session.js for
   * what that costs (server-side revocation) and how a password rotation still
   * invalidates old tokens. */
  let token;
  if (session.isStateless()) {
    token = session.issue(e, u.hash, { ttlMs: SESSION_TTL_MS }).token;
  } else {
    token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { email: e, created: now, expires: now + SESSION_TTL_MS });
  }

  u.last_login = new Date().toISOString();
  u.login_count = (u.login_count || 0) + 1;
  writeUsers(store);

  return { ok: true, token, email: e, expires_in_ms: SESSION_TTL_MS };
}

function sessionFor(token) {
  if (!token) return null;

  // A stateless token carries a "." separating payload from signature; an
  // opaque one is plain hex. Checking the shape avoids a pointless HMAC on
  // every stateful request.
  if (session.isStateless() || token.includes(".")) {
    const v = session.verify(token, email => {
      const u = readUsers().users[String(email).toLowerCase()];
      return u ? u.hash : null;
    });
    if (v) return v;
    if (session.isStateless()) return null;
    // Fall through: a stateful process may still hold this token.
  }

  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  return s;
}

function logout(token) {
  const removed = sessions.delete(token);
  /* In stateless mode there is nothing server-side to delete. The caller still
   * clears the cookie, which ends the session for that browser, but a copied
   * token stays valid until it expires. Returning the mode lets the API say so
   * rather than implying a revocation that did not happen. */
  return { removed, revoked_server_side: !session.isStateless() && removed };
}

/** Periodically drop expired sessions so the map cannot grow unbounded. */
function sweep() {
  const now = Date.now();
  for (const [t, s] of sessions) if (now > s.expires) sessions.delete(t);
}

function status() {
  const store = readUsers();
  return {
    configured: Object.keys(store.users || {}).length,
    allowed: ALLOWED_EMAILS.length,
    accounts: ALLOWED_EMAILS.map(e => {
      const u = (store.users || {})[e];
      return {
        email: e,
        provisioned: !!u,
        last_login: u ? u.last_login : null,
        login_count: u ? u.login_count || 0 : 0,
      };
    }),
    active_sessions: sessions.size,
    accounts_from: usersSource(),
    session_mode: session.isStateless() ? "stateless (HMAC-signed cookie)" : "stateful (opaque server-side token)",
    session_secret_configured: !!(process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32),
  };
}

module.exports = {
  ALLOWED_EMAILS,
  initUsers,
  login,
  logout,
  sessionFor,
  usersSource,
  sweep,
  status,
  generatePassword,
  hashPassword,
  verifyPassword,
  USERS_FILE,
};
