/**
 * Session tokens, in two modes — because the right answer differs between a
 * long-lived local process and a serverless host.
 *
 * STATEFUL (default, local `npm start`)
 *   Opaque random token, session held in process memory. Logout genuinely
 *   revokes, and the cookie carries no user data to tamper with. This is what
 *   auth.js was built around and it remains the better mode when it works.
 *
 * STATELESS (serverless: Vercel and anything else without shared memory)
 *   HMAC-signed token carrying {email, expiry, password-fingerprint}. Required
 *   there because each cold start is a fresh process: an in-memory session map
 *   would log the whole team out at unpredictable intervals, which reads as a
 *   broken login rather than a security posture.
 *
 * WHAT STATELESS COSTS, STATED PLAINLY
 *   Server-side revocation. `logout` can clear the cookie but cannot invalidate
 *   a token someone already copied. Two things bound that:
 *
 *     1. A 12-hour expiry, enforced inside the signature.
 *     2. A password fingerprint — the first 16 hex of SHA-256 over the user's
 *        stored hash. Rotating a password (`npm run auth:init -- --reset`)
 *        changes the fingerprint, so every token issued for the old password
 *        stops verifying immediately. That restores real revocation for the
 *        case that actually matters: a credential you need to kill.
 *
 * The signature is HMAC-SHA256 over the payload, compared with
 * timingSafeEqual. An unsigned or edited payload never verifies, so the email
 * in the cookie cannot be swapped for someone else's.
 */
const crypto = require("crypto");

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Serverless hosts have no shared memory; detect rather than require config. */
function isStateless() {
  if (process.env.DEPLOY_MODE === "readonly") return true;
  if (process.env.SESSION_MODE === "stateless") return true;
  if (process.env.SESSION_MODE === "stateful") return false;
  // Vercel, Netlify and AWS Lambda all set one of these.
  return !!(process.env.VERCEL || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

/**
 * The HMAC key. In stateless mode a missing key is fatal rather than
 * silently substituted: a random per-process key would verify nothing after a
 * cold start, producing exactly the mystery logouts this module exists to
 * prevent.
 */
function secret() {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (isStateless()) {
    throw new Error(
      "SESSION_SECRET is required in a serverless deployment (min 32 chars). " +
      "Without it every cold start invalidates all sessions. Generate one with: " +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  // Stateful mode never verifies a signature, so no key is needed.
  return null;
}

const b64u = buf => Buffer.from(buf).toString("base64url");
const unb64u = s => Buffer.from(String(s), "base64url").toString("utf8");

/** Fingerprint of the stored password hash — changes whenever it is rotated. */
function fingerprint(passwordHash) {
  return crypto.createHash("sha256").update(String(passwordHash || "")).digest("hex").slice(0, 16);
}

function sign(payloadB64, key) {
  return crypto.createHmac("sha256", key).update(payloadB64).digest("base64url");
}

/** Issue a stateless token. */
function issue(email, passwordHash, { ttlMs = SESSION_TTL_MS } = {}) {
  const key = secret();
  const expires = Date.now() + ttlMs;
  const payload = b64u(JSON.stringify({
    e: String(email).toLowerCase(),
    x: expires,
    f: fingerprint(passwordHash),
    // Random nonce so two logins in the same millisecond differ.
    n: crypto.randomBytes(8).toString("base64url"),
  }));
  return { token: `${payload}.${sign(payload, key)}`, expires };
}

/**
 * Verify a stateless token. Returns { email, expires } or null.
 * `lookupHash` maps an email to its current stored hash, so a rotated password
 * invalidates the token.
 */
function verify(token, lookupHash) {
  const key = secret();
  if (!key || !token || typeof token !== "string") return null;

  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payloadB64 = token.slice(0, dot);
  const given = token.slice(dot + 1);

  const expected = sign(payloadB64, key);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // Length must match before timingSafeEqual, which throws on a mismatch.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let claims;
  try { claims = JSON.parse(unb64u(payloadB64)); } catch (e) { return null; }
  if (!claims || !claims.e || !claims.x) return null;
  if (Date.now() > Number(claims.x)) return null;

  // The fingerprint check is what makes a password rotation revoke old tokens.
  const currentHash = typeof lookupHash === "function" ? lookupHash(claims.e) : null;
  if (!currentHash) return null;
  if (claims.f !== fingerprint(currentHash)) return null;

  return { email: claims.e, expires: Number(claims.x), stateless: true };
}

module.exports = { isStateless, issue, verify, fingerprint, SESSION_TTL_MS, secret };
