/**
 * ScrapingBee client — fetches pages that refuse a plain request.
 *
 * WHAT THIS SOLVES
 * ----------------
 * Five of the seven review directories answer a direct fetch with HTTP 403:
 * G2, Capterra, TrustRadius, SoftwareAdvice, Gartner. Their robots.txt files
 * permit product and category pages — TrustRadius says `Allow: /` — so it is a
 * WAF refusing us, not a policy. The audit therefore read them second-hand
 * through a search index, which loses the page's own structure.
 *
 * MEASURED 2026-09-10, G2's knowledge-base category page:
 *
 *     default         HTTP 500     2,980 bytes   bot-walled, 0 products
 *     premium_proxy   HTTP 200     2,562 bytes   bot-walled, 0 products
 *     stealth_proxy   HTTP 200   948,680 bytes   17 distinct products
 *
 * So `stealth_proxy=true` is not a tuning preference, it is the only mode that
 * works on these hosts — and the default mode fails in two different ways
 * (a 500, and a 200 containing a challenge page). Both are handled explicitly,
 * because a 200 carrying a CAPTCHA is the more dangerous of the two: it looks
 * like success and yields an empty parse.
 *
 * CREDITS ARE THE CONSTRAINT
 * --------------------------
 * 1,000 credits on the plan, and stealth mode costs more per call than a plain
 * fetch. So every response is cached, spend is tracked, and a reserve is held
 * back. A blocked call reports "not fetched — credits", never an empty page.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { fetchUrl, fetchJson } = require("./fetch");

const BASE = "https://app.scrapingbee.com/api/v1";
const STORE = path.join(__dirname, "..", "store");
const CACHE_FILE = path.join(STORE, "scrapingbee-cache.json");
const SPEND_FILE = path.join(STORE, "scrapingbee-spend.json");

/** Directory listings change over days, not minutes. */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Hosts known to need stealth mode, from the measurement above. */
const NEEDS_STEALTH = /(^|\.)(g2|capterra|trustradius|softwareadvice|gartner|getapp|softwaresuggest)\.com$/i;

/** Signs that a 200 response is actually a challenge page, not the content. */
const CHALLENGE = /captcha|are you a robot|access denied|cf-browser-verification|just a moment|checking your browser|enable javascript and cookies/i;

function key() { return process.env.SCRAPINGBEE_KEY || ""; }
function configured() { return !!key(); }

function credentialStatus() {
  if (!configured()) {
    return {
      ok: false,
      reason: "SCRAPINGBEE_KEY is not set — bot-walled pages cannot be fetched.",
      how_to_enable: "Add SCRAPINGBEE_KEY to .env, then run: npm run probe:providers",
    };
  }
  return { ok: true, reason: null };
}

function readJsonSafe(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return fallback; }
}
function writeJsonSafe(f, obj) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(obj, null, 2));
  } catch (e) { /* cache only */ }
}

/** Live credit balance. Free to call. */
async function usage() {
  if (!configured()) return { ok: false, reason: credentialStatus().reason };
  const r = await fetchJson(`${BASE}/usage?api_key=${key()}`, { retries: 1, timeout: 30000 });
  if (!r.ok || !r.json) return { ok: false, status: r.status, reason: `HTTP ${r.status}` };
  const u = r.json;
  return {
    ok: true,
    used: u.used_api_credit ?? null,
    max: u.max_api_credit ?? null,
    remaining: (u.max_api_credit ?? 0) - (u.used_api_credit ?? 0),
    concurrency: u.max_concurrency ?? null,
    renews_at: u.renewal_subscription_date || null,
  };
}

function recordFetch(url, meta = {}) {
  const s = readJsonSafe(SPEND_FILE, { calls: 0, by_day: {}, recent: [] });
  const day = new Date().toISOString().slice(0, 10);
  s.calls++;
  s.by_day[day] = (s.by_day[day] || 0) + 1;
  s.recent = [{ at: new Date().toISOString(), url: String(url).slice(0, 120), ...meta }, ...(s.recent || [])].slice(0, 200);
  writeJsonSafe(SPEND_FILE, s);
}

/**
 * Fetch a URL through ScrapingBee.
 *
 * Stealth mode is chosen automatically for the hosts measured to require it,
 * and can be forced. Returns a receipt shaped like lib/fetch.js so callers can
 * treat it as an ordinary fetch, plus `via` so provenance records which route
 * actually retrieved the bytes.
 */
async function fetch(url, {
  stealth = null,          // null = decide from the host
  renderJs = false,
  useCache = true,
  log = () => {},
} = {}) {
  const cred = credentialStatus();
  if (!cred.ok) return { ok: false, status: 0, error: cred.reason, skipped: "not_configured" };

  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch (e) {
    return { ok: false, status: 0, error: `invalid url: ${url}` };
  }
  const useStealth = stealth == null ? NEEDS_STEALTH.test(host) : !!stealth;

  const ck = crypto.createHash("sha1")
    .update(JSON.stringify([url, useStealth, renderJs])).digest("hex").slice(0, 20);

  if (useCache) {
    const c = readJsonSafe(CACHE_FILE, { entries: {} });
    const hit = c.entries[ck];
    if (hit && Date.now() - new Date(hit.cached_at).getTime() < CACHE_TTL_MS) {
      log(`      scrapingbee: cache hit ${host} (${hit.bytes} bytes) — 0 credits`);
      return { ...hit, ok: true, from_cache: true, via: "scrapingbee (cached)" };
    }
  }

  const reserve = Number(process.env.SCRAPINGBEE_MIN_CREDITS || 25);
  const u = await usage();
  if (u.ok && u.remaining != null && u.remaining <= reserve) {
    log(`      scrapingbee: SKIPPED — ${u.remaining} credit(s) left, reserve ${reserve}`);
    return {
      ok: false, status: 0, skipped: "credits",
      error:
        `Skipped: ${u.remaining} ScrapingBee credit(s) remain and the reserve is ${reserve}. ` +
        `This is a credit stop, NOT an empty page. Top up or lower SCRAPINGBEE_MIN_CREDITS.`,
    };
  }

  const params = new URLSearchParams({ api_key: key(), url });
  if (useStealth) params.set("stealth_proxy", "true");
  if (renderJs) params.set("render_js", "true");
  else if (!useStealth) params.set("render_js", "false");   // stealth implies rendering

  const r = await fetchUrl(`${BASE}/?${params}`, {
    retries: 1,
    timeout: 150000,          // stealth fetches are slow; measured up to ~60s
    maxBytes: 16 * 1024 * 1024,
  });
  recordFetch(url, { stealth: useStealth, status: r.status, bytes: r.bytes });

  // A 200 carrying a challenge page is the dangerous case: it looks like
  // success and parses to nothing. Caught explicitly and reported as blocked.
  const challenged = r.ok && CHALLENGE.test(r.body || "") && r.bytes < 50000;
  if (challenged) {
    log(`      scrapingbee: ${host} returned a challenge page inside HTTP 200 (${r.bytes} bytes)`);
    return {
      ok: false,
      status: r.status,
      bytes: r.bytes,
      error:
        `${host} served a bot challenge inside an HTTP 200 (${r.bytes} bytes). ` +
        (useStealth ? "Stealth mode did not get through this time." : "Retry with stealth:true."),
      blocked: true,
      via: `scrapingbee (${useStealth ? "stealth" : "default"})`,
    };
  }

  if (!r.ok) {
    return {
      ok: false, status: r.status, bytes: r.bytes,
      error: `ScrapingBee HTTP ${r.status}: ${String(r.body || "").replace(/\s+/g, " ").slice(0, 160)}`,
      via: `scrapingbee (${useStealth ? "stealth" : "default"})`,
    };
  }

  const receipt = {
    ok: true,
    status: r.status,
    url,
    final_url: url,
    fetched_at: new Date().toISOString(),
    bytes: r.bytes,
    content_sha256: r.content_sha256,
    body: r.body,
    via: `scrapingbee (${useStealth ? "stealth" : "default"})`,
    stealth: useStealth,
    from_cache: false,
    error: null,
  };

  const c = readJsonSafe(CACHE_FILE, { entries: {} });
  // Only the metadata and body of successful fetches are worth caching, and the
  // file is bounded because these bodies are large.
  c.entries[ck] = { ...receipt, cached_at: new Date().toISOString() };
  const keys = Object.keys(c.entries);
  if (keys.length > 60) {
    keys.map(k => [k, c.entries[k].cached_at])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
      .slice(0, keys.length - 60)
      .forEach(([k]) => delete c.entries[k]);
  }
  writeJsonSafe(CACHE_FILE, c);

  log(`      scrapingbee: ${host} ${r.bytes} bytes via ${useStealth ? "stealth" : "default"} proxy`);
  return receipt;
}

/** Would this host need ScrapingBee at all? */
function needsProxy(url) {
  try { return NEEDS_STEALTH.test(new URL(url).hostname.replace(/^www\./, "")); }
  catch (e) { return false; }
}

module.exports = {
  BASE, configured, credentialStatus, usage, fetch, needsProxy,
  NEEDS_STEALTH, CACHE_FILE, SPEND_FILE,
};
