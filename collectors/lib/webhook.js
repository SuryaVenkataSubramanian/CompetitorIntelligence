/**
 * Outbound webhook notifications.
 *
 * The dashboard stores a webhook URL, verifies it with a test ping on enable, and
 * posts a signed payload when new mentions land.
 *
 * SECURITY DECISIONS
 * ------------------
 * 1. SSRF GUARD. The URL is user-supplied and the server makes the request, so an
 *    unguarded implementation lets someone point it at 169.254.169.254 (cloud
 *    metadata) or an internal host and use this server as a proxy. Only https
 *    (or http to an explicitly non-private host) is accepted, and private,
 *    loopback, link-local and reserved ranges are refused.
 *
 * 2. SIGNED PAYLOADS. Each delivery carries an HMAC-SHA256 signature over the
 *    exact body, using a secret generated when the webhook is saved. The receiver
 *    can therefore verify the request genuinely came from this dashboard.
 *
 * 3. THE SECRET IS SHOWN ONCE. It is needed by the receiver, so it is returned on
 *    save and never again — only its hash-prefix hint is exposed afterwards.
 *
 * 4. DELIVERY IS BOUNDED. Timeouts, capped retries with backoff, and a delivery
 *    log. A failing endpoint must never wedge a collector run.
 */
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const dns = require("dns").promises;
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const STORE_DIR = path.join(__dirname, "..", "store");
const CONFIG = path.join(STORE_DIR, "webhook.json");

const TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 3;
const MAX_LOG = 50;

/* ------------------------------------------------------------- SSRF guard */

/** Private / reserved IPv4 and IPv6 ranges that must never be a webhook target. */
function isPrivateAddress(addr, family) {
  if (family === 6) {
    const a = addr.toLowerCase();
    if (a === "::1" || a === "::") return true;
    if (a.startsWith("fe80:")) return true;          // link-local
    if (/^f[cd][0-9a-f]{2}:/.test(a)) return true;   // unique local fc00::/7
    // IPv4-mapped (::ffff:a.b.c.d) — re-check as IPv4
    const m = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateAddress(m[1], 4);
    return false;
  }
  const p = addr.split(".").map(Number);
  if (p.length !== 4 || p.some(x => !Number.isFinite(x))) return true;
  const [a, b] = p;
  if (a === 10) return true;                          // 10/8
  if (a === 127) return true;                         // loopback
  if (a === 0) return true;                           // this network
  if (a === 169 && b === 254) return true;            // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16/12
  if (a === 192 && b === 168) return true;            // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT 100.64/10
  if (a >= 224) return true;                          // multicast / reserved
  return false;
}

/**
 * Validate a webhook URL, resolving DNS so a hostname cannot be used to smuggle
 * a private address past a string check.
 */
async function validateUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); }
  catch (e) { return { ok: false, error: "Not a valid URL." }; }

  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, error: `Protocol ${u.protocol} is not allowed — use https.` };
  }
  if (u.username || u.password) {
    return { ok: false, error: "Credentials embedded in the URL are not allowed." };
  }

  let addrs = [];
  try {
    addrs = await dns.lookup(u.hostname, { all: true });
  } catch (e) {
    return { ok: false, error: `Hostname could not be resolved: ${u.hostname}` };
  }
  for (const a of addrs) {
    if (isPrivateAddress(a.address, a.family)) {
      return {
        ok: false,
        error:
          `${u.hostname} resolves to ${a.address}, a private or reserved address. ` +
          `Webhooks must point at a public endpoint — this is refused to prevent the ` +
          `server being used to reach internal services.`,
      };
    }
  }
  if (u.protocol === "http:") {
    return { ok: true, warning: "Using http: the payload and signature travel unencrypted. Prefer https." };
  }
  return { ok: true, warning: null };
}

/* -------------------------------------------------------------- config io */

function read() {
  try {
    if (!fs.existsSync(CONFIG)) return { enabled: false, url: null, events: [], log: [] };
    return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch (e) {
    return { enabled: false, url: null, events: [], log: [] };
  }
}

function write(cfg) {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** Public view — never leaks the signing secret. */
function publicConfig() {
  const c = read();
  return {
    enabled: !!c.enabled,
    url: c.url || null,
    events: c.events || [],
    secret_hint: c.secret ? `${c.secret.slice(0, 6)}…(${c.secret.length} chars)` : null,
    created_at: c.created_at || null,
    last_delivery: (c.log || [])[0] || null,
    deliveries: (c.log || []).length,
    recent: (c.log || []).slice(0, 10),
  };
}

const DEFAULT_EVENTS = ["new_mentions", "negative_mention", "buying_intent", "new_competitor"];

/* --------------------------------------------------------------- delivery */

function sign(secret, body) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function post(urlStr, body, headers) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return resolve({ ok: false, status: 0, error: "bad url" }); }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        timeout: TIMEOUT_MS,
      },
      res => {
        let b = "";
        res.on("data", c => { if (b.length < 2000) b += c; });
        res.on("end", () =>
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: b.slice(0, 300) }));
      }
    );
    req.on("timeout", () => req.destroy(new Error(`timeout after ${TIMEOUT_MS}ms`)));
    req.on("error", e => resolve({ ok: false, status: 0, error: String(e.message || e) }));
    req.write(body);
    req.end();
  });
}

/**
 * Deliver one event. Retries transient failures (timeout / 5xx / 429) with
 * backoff; a 4xx is a permanent rejection and is not retried.
 */
async function deliver(event, payload) {
  const cfg = read();
  if (!cfg.enabled || !cfg.url) return { ok: false, skipped: "webhook not enabled" };
  if ((cfg.events || []).length && !cfg.events.includes(event)) {
    return { ok: false, skipped: `event "${event}" not subscribed` };
  }

  const body = JSON.stringify({
    event,
    sent_at: new Date().toISOString(),
    source: "document360-competitive-intel",
    payload,
  });
  const signature = sign(cfg.secret, body);

  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await post(cfg.url, body, {
      "Content-Type": "application/json",
      "User-Agent": "D360-CompetitiveIntel-Webhook/1.0",
      "X-D360-Event": event,
      "X-D360-Signature": `sha256=${signature}`,
      "X-D360-Delivery": crypto.randomUUID(),
    });
    if (last.ok) break;
    const retryable = last.status === 0 || last.status === 429 || last.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) break;
    await new Promise(r => setTimeout(r, 800 * attempt));
  }

  const entry = {
    at: new Date().toISOString(),
    event,
    ok: last.ok,
    status: last.status,
    error: last.error || null,
    response: last.body || null,
  };
  const fresh = read();
  fresh.log = [entry, ...(fresh.log || [])].slice(0, MAX_LOG);
  write(fresh);
  return { ...last, event };
}

/* ----------------------------------------------------------------- config */

/** Save + verify. A webhook is only enabled if the test ping actually succeeds. */
async function configure({ url, events, enabled }) {
  if (enabled === false) {
    const cfg = read();
    cfg.enabled = false;
    write(cfg);
    return { ok: true, disabled: true, config: publicConfig() };
  }

  const v = await validateUrl(url);
  if (!v.ok) return { ok: false, error: v.error };

  const existing = read();
  // Reuse the secret if the URL is unchanged, so an already-configured receiver
  // does not silently start failing signature checks.
  const secret = existing.url === url && existing.secret
    ? existing.secret
    : crypto.randomBytes(32).toString("hex");
  const isNewSecret = secret !== existing.secret;

  write({
    enabled: true,
    url,
    secret,
    events: Array.isArray(events) && events.length ? events : DEFAULT_EVENTS,
    created_at: existing.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    log: existing.log || [],
  });

  // Verify by actually calling it — "enabled" should mean "proven reachable".
  const ping = await deliver("test", {
    message: "Webhook enabled successfully for the Document360 Competitive Intelligence dashboard.",
    verify: "Compare X-D360-Signature against HMAC-SHA256 of the raw body using your secret.",
  });

  if (!ping.ok) {
    const cfg = read();
    cfg.enabled = false;
    write(cfg);
    return {
      ok: false,
      error:
        `Saved, but the test delivery failed (${ping.status || ping.error}), so the webhook was NOT enabled. ` +
        `Fix the endpoint and save again.`,
      test: ping,
    };
  }

  return {
    ok: true,
    warning: v.warning,
    // The secret is returned ONCE, because the receiver needs it to verify.
    secret: isNewSecret ? secret : null,
    secret_note: isNewSecret
      ? "Store this now — it is shown once and used to verify X-D360-Signature."
      : "Existing secret reused because the URL is unchanged.",
    test: ping,
    config: publicConfig(),
  };
}

async function testPing() {
  return deliver("test", { message: "Manual test ping from the dashboard." });
}

module.exports = {
  configure, deliver, testPing, publicConfig, validateUrl,
  DEFAULT_EVENTS, isPrivateAddress, sign, CONFIG,
};
