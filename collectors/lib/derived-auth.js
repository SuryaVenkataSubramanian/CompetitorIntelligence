/**
 * Passwords derived from SESSION_SECRET — no provisioning, no storage.
 *
 * WHY THIS MODE EXISTS
 * --------------------
 * Every other model needs something written somewhere before anyone can log
 * in: a gitignored file (absent on a fresh deploy), an environment variable
 * pasted by hand, or a database. Each turns "share the URL" into "and also run
 * this local command first", which is not a hosted application.
 *
 * Here the password for an account is a pure function of SESSION_SECRET and the
 * email address:
 *
 *     password(email) = base32( HMAC-SHA256(SESSION_SECRET, "d360-pw:v1:" + email) )[0..15]
 *
 * The server recomputes it on every login and compares in constant time.
 * Nothing is stored, so nothing can be missing. Deploy the code, set one
 * environment variable, and the login works — on Vercel, locally, anywhere.
 *
 * PROPERTIES, INCLUDING THE UNCOMFORTABLE ONE
 * -------------------------------------------
 *  · Strength: 16 characters from a 32-symbol alphabet = 80 bits. Same as the
 *    generated passwords it replaces.
 *  · Stable: the same secret always yields the same passwords, so two
 *    deployments sharing SESSION_SECRET accept the same credentials.
 *  · Rotation: change SESSION_SECRET and every password changes at once. That
 *    also invalidates every session, which is the correct behaviour for a
 *    secret rotation.
 *  · NO INDIVIDUAL ROTATION. One person's password cannot be changed without
 *    changing everyone's, because there is no per-user state to change. That
 *    is the real cost of storing nothing, and it is why this suits a small
 *    internal tool and would not suit a product.
 *  · Anyone holding SESSION_SECRET can derive all four passwords. They could
 *    already forge a session cookie with it, so this grants no new capability —
 *    but it does mean SESSION_SECRET is now the only thing that matters. It
 *    belongs in the host's environment variables and nowhere else.
 *
 * The allow-list in auth.js remains the authority on WHO may authenticate.
 * Derivation only answers WHAT their password is.
 */
const crypto = require("crypto");

/** Same alphabet as the generated passwords: no 0/O or 1/l/I to mistype. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Bumping this changes every derived password without touching SESSION_SECRET. */
const VERSION = "v1";

const GROUPS = 4;
const GROUP_LEN = 4;

function secret() {
  return process.env.SESSION_SECRET || "";
}

/** Is this mode usable? It needs only a strong SESSION_SECRET. */
function available() {
  return secret().length >= 32;
}

/**
 * The password for one account.
 *
 * Each character consumes one byte of HMAC output, mapped into the alphabet by
 * rejection-free modulo. 32 divides 256 exactly, so the modulo introduces no
 * bias — worth stating, because a biased mapping would quietly reduce entropy.
 */
function derivePassword(email) {
  const key = secret();
  if (key.length < 32) {
    throw new Error(
      "SESSION_SECRET is required to derive passwords (min 32 chars). " +
      'Generate one with: npm run session:secret'
    );
  }
  const normalised = String(email || "").trim().toLowerCase();
  const mac = crypto.createHmac("sha256", key)
    .update(`d360-pw:${VERSION}:${normalised}`)
    .digest();

  const need = GROUPS * GROUP_LEN;
  const chars = [];
  for (let i = 0; i < need; i++) {
    // 256 % 32 === 0, so this mapping is uniform.
    chars.push(ALPHABET[mac[i] % ALPHABET.length]);
  }

  const groups = [];
  for (let g = 0; g < GROUPS; g++) {
    groups.push(chars.slice(g * GROUP_LEN, (g + 1) * GROUP_LEN).join(""));
  }
  return groups.join("-");
}

/**
 * Verify a submitted password against the derived one.
 * Constant-time, so response timing cannot be used to narrow a guess.
 */
function verify(email, submitted) {
  if (!available()) return false;
  let expected;
  try { expected = derivePassword(email); } catch (e) { return false; }

  const a = Buffer.from(String(submitted || ""), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Every allow-listed account with its derived password, for sharing. */
function allPasswords(emails) {
  if (!available()) return [];
  return emails.map(email => ({ email, password: derivePassword(email) }));
}

/**
 * A fingerprint of the current secret. Lets the UI and /api/status show WHICH
 * secret is in force without revealing it — so a mismatch between local and
 * deployed is visible at a glance rather than inferred from a failed login.
 */
function secretFingerprint() {
  if (!available()) return null;
  return crypto.createHash("sha256").update(secret()).digest("hex").slice(0, 8);
}

module.exports = {
  available, derivePassword, verify, allPasswords, secretFingerprint,
  ALPHABET, VERSION,
};
