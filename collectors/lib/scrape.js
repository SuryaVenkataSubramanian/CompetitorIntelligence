/**
 * One scraping entry point, with an explicit fallback chain.
 *
 *   direct fetch  →  ScrapeBadger  →  ScrapingBee (stealth)
 *
 * WHY A CHAIN RATHER THAN A PROVIDER PER CALLER
 * ---------------------------------------------
 * Callers kept choosing a provider themselves, so when one died the code that
 * used it went quiet and the rest carried on. Bright Data suspending mid-session
 * took LinkedIn and X down with it; SearXNG stopping took Events and SERP down.
 * Each was a separate silent failure with a separate fix.
 *
 * Here every scrape goes through one place, tries each route in order, and
 * returns a receipt naming which route actually retrieved the bytes. A dead
 * provider costs one wasted attempt instead of a dead channel.
 *
 * WHAT EACH ROUTE IS FOR
 * ----------------------
 *   direct        Free and fast. Works for most of the web.
 *   ScrapeBadger  POST /v1/web/scrape. 998 credits on the free tier, so it
 *                 carries the volume. It DECLINES hard bot walls with
 *                 422 blocking_page_detected rather than fighting them, which
 *                 is cheap to detect and hand on.
 *   ScrapingBee   Last, because 895 credits is the scarcer pool — but it is the
 *                 only route that beats the review-directory walls. MEASURED on
 *                 G2: default HTTP 500, premium_proxy a 2.5KB challenge page,
 *                 stealth_proxy 948KB of real HTML with 17 products.
 *
 * Order is by ABUNDANCE THEN CAPABILITY: spend the plentiful provider first,
 * keep the scarce-but-stronger one for the pages that need it. For hosts
 * already known to be walled the first two are skipped entirely, so a G2 fetch
 * does not burn a ScrapeBadger credit and 13 seconds to learn what is already
 * recorded.
 *
 * A 200 CARRYING A CHALLENGE PAGE IS THE DANGEROUS CASE. It looks like success
 * and parses to nothing, which is how a bot wall becomes "this company has no
 * products". Detected here, and treated as a failure so the next route is tried.
 */
const { fetchUrl, fetchJson } = require("./fetch");
const scrapingbee = require("./scrapingbee");

/** Signs that a 200 response is a challenge, not the content. */
const CHALLENGE = /captcha|are you a robot|access denied|cf-browser-verification|just a moment|checking your browser|enable javascript and cookies|attention required/i;

/** Hosts measured to refuse a direct fetch, so the direct attempt is skipped. */
const KNOWN_WALLED = /(^|\.)(g2|capterra|trustradius|softwareadvice|gartner)\.com$/i;

function looksBlocked(r) {
  if (!r || !r.ok) return true;
  // A small body containing challenge wording is a wall; a large page that
  // merely mentions "captcha" somewhere is not.
  if (CHALLENGE.test(r.body || "") && (r.bytes || 0) < 50000) return true;
  // An empty 200 is not content either.
  if ((r.bytes || 0) < 500) return true;
  return false;
}

/* ------------------------------------------------------------- ScrapeBadger */

/**
 * I GOT THIS WRONG THE FIRST TIME, AND THE MISTAKE IS WORTH RECORDING.
 *
 * I probed /api/v1/scrape, /api/v1/scrapers, /api/v1/account and a dozen
 * similar guesses. Every one answered
 *   {"error":"Scraper Not Found","message":"Scraper '<name>' is not configured"}
 * so I concluded it was a configure-a-scraper-in-the-dashboard product with no
 * generic endpoint. That was wrong. I had never read the docs.
 *
 * The real API, from docs.scrapebadger.com:
 *
 *   POST https://scrapebadger.com/v1/web/scrape
 *   x-api-key: <key>
 *   {"url": "...", "format": "markdown" | "html"}
 *
 * Note /v1/, not /api/v1/ — which is why every guess 404'd. Verified working:
 * example.com returned {"success":true,"content":"..."} and the account reports
 * 998 credits on the free tier.
 *
 * TWO LIMITS THAT SHAPE ITS PLACE IN THE CHAIN
 *
 *   5 requests/minute on the free tier. A 6th gets 429, and tripping that made
 *   real endpoints look like 404s three separate times while probing — the
 *   limiter fires before routing, so a rate-limited call and a wrong path are
 *   indistinguishable. Throttled in lib/fetch.js to one request per 13s.
 *
 *   It REFUSES hard bot walls rather than fighting them: G2 came back
 *   422 {"error":"blocking_page_detected"}. That is honest behaviour and cheap
 *   to detect, which is why ScrapingBee stealth still sits behind it for those
 *   specific hosts.
 */
const BADGER_BASE = "https://scrapebadger.com/v1";

function badgerStatus() {
  const key = process.env.SCRAPEBADGER_KEY || "";
  if (!key) return { ok: false, reason: "SCRAPEBADGER_KEY is not set." };
  return { ok: true };
}

/** Remaining credits. Cheap, but it does consume one of the 5 per minute. */
async function badgerAccount() {
  const st = badgerStatus();
  if (!st.ok) return { ok: false, reason: st.reason };
  const r = await fetchJson(BADGER_BASE + "/account/me", {
    headers: { "x-api-key": process.env.SCRAPEBADGER_KEY }, retries: 1, timeout: 40000,
  });
  if (!r.ok || !r.json) return { ok: false, status: r.status, reason: "HTTP " + r.status };
  const j = r.json;
  return {
    ok: true,
    credits: j.total_credits_balance ?? j.credits_balance ?? null,
    tier: j.tier || null,
    rate_limit_per_minute: j.rate_limit_per_minute ?? null,
  };
}

async function viaBadger(url, { format = "html", log = () => {} } = {}) {
  const st = badgerStatus();
  if (!st.ok) return { ok: false, skipped: "not_configured", error: st.reason, via: "scrapebadger" };

  const payload = JSON.stringify({ url, format });
  const r = await fetchUrl(BADGER_BASE + "/web/scrape", {
    method: "POST",
    headers: {
      "x-api-key": process.env.SCRAPEBADGER_KEY,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
    body: payload,
    retries: 1,
    timeout: 120000,
    maxBytes: 16 * 1024 * 1024,
  });

  let j = null;
  try { j = JSON.parse(r.body); } catch (e) { /* handled below */ }

  // 422 blocking_page_detected: it saw a bot wall and declined. Recorded as a
  // blocked attempt so the chain moves on to a route that can fight one.
  if (r.status === 422 || (j && j.error === "blocking_page_detected")) {
    return {
      ok: false,
      status: r.status,
      blocked: true,
      error: "ScrapeBadger declined: " + ((j && j.error) || "blocking_page_detected") +
        " — the target served a bot wall",
      via: "scrapebadger",
    };
  }
  if (r.status === 429) {
    return {
      ok: false,
      status: 429,
      rate_limited: true,
      error: "ScrapeBadger rate limit: free tier allows 5 requests per minute",
      via: "scrapebadger",
    };
  }
  if (!r.ok || !j || j.success !== true) {
    const detail = String((j && (j.error || j.detail)) || r.body || "").replace(/\s+/g, " ").slice(0, 160);
    return {
      ok: false,
      status: r.status,
      error: "ScrapeBadger HTTP " + r.status + ": " + detail,
      via: "scrapebadger",
    };
  }

  const body = j.content || "";
  log("      scrapebadger: " + url.slice(0, 58) + " -> " + body.length + " chars (upstream " + j.status_code + ")");
  return {
    ok: true,
    status: j.status_code || r.status,
    url,
    final_url: j.url || url,
    fetched_at: new Date().toISOString(),
    bytes: Buffer.byteLength(body),
    content_sha256: r.content_sha256,
    body,
    via: "scrapebadger",
    format,
    error: null,
  };
}

/* ------------------------------------------------------------- the chain */

/**
 * Fetch a page, trying each route until one returns real content.
 *
 * Always returns a receipt. `via` names the route that succeeded, and
 * `attempts` records every route tried with why it failed — so a page that
 * could not be retrieved is explainable rather than just absent.
 */
async function fetchPage(url, {
  forceProxy = false,
  renderJs = false,
  log = () => {},
} = {}) {
  const attempts = [];
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch (e) {
    return { ok: false, error: `invalid url: ${url}`, attempts, via: null };
  }

  /* 1. Direct — unless this host is already known to refuse one, in which case
   *    the attempt is pure latency. */
  const skipDirect = forceProxy || KNOWN_WALLED.test(host);
  if (!skipDirect) {
    const r = await fetchUrl(url, { retries: 1, timeout: 25000 });
    if (!looksBlocked(r)) {
      return { ...r, via: "direct", attempts };
    }
    attempts.push({
      route: "direct",
      status: r.status,
      bytes: r.bytes,
      why: r.ok ? "response looked like a bot challenge or was too small to be content" : `HTTP ${r.status}`,
    });
  } else {
    attempts.push({ route: "direct", skipped: true, why: `${host} is known to refuse a direct fetch` });
  }

  /* 2. ScrapeBadger — the abundant pool (998 credits), so it carries volume.
   *    Skipped for hosts already known to be walled: it declines those with
   *    422 blocking_page_detected, and learning that again would cost a credit
   *    and 13 seconds of throttle for nothing. */
  if (!KNOWN_WALLED.test(host)) {
    const b = await viaBadger(url, { format: renderJs ? "html" : "html", log });
    if (b.ok && !looksBlocked(b)) {
      return { ...b, attempts };
    }
    attempts.push({
      route: "scrapebadger",
      status: b.status || null,
      skipped: b.skipped || null,
      blocked: !!b.blocked,
      why: b.error || "returned no usable content",
    });
  } else {
    attempts.push({
      route: "scrapebadger",
      skipped: true,
      why: `${host} is a known bot wall, which ScrapeBadger declines with 422 blocking_page_detected`,
    });
  }

  /* 3. ScrapingBee — last, because 895 credits is the scarcer pool, but it is
   *    the only route that beats the review-directory walls. */
  if (scrapingbee.configured()) {
    const r = await scrapingbee.fetch(url, { renderJs, log });
    if (r.ok && !looksBlocked(r)) {
      return { ...r, attempts };
    }
    attempts.push({
      route: "scrapingbee",
      status: r.status || null,
      bytes: r.bytes || 0,
      skipped: r.skipped || null,
      why: r.error || "returned no usable content",
    });
  } else {
    attempts.push({ route: "scrapingbee", skipped: true, why: scrapingbee.credentialStatus().reason });
  }

  return {
    ok: false,
    status: 0,
    url,
    bytes: 0,
    body: "",
    via: null,
    attempts,
    error:
      `All ${attempts.length} scraping routes failed for ${host}. ` +
      attempts.map(a => `${a.route}: ${String(a.why).slice(0, 70)}`).join(" | "),
  };
}

/** What each route can do right now, for the health check and the UI. */
function routeStatus() {
  const bee = scrapingbee.credentialStatus();
  const badger = badgerStatus();
  return {
    direct: { available: true, note: "Free. Blocked by the WAF on g2, capterra, trustradius, softwareadvice and gartner." },
    scrapingbee: {
      available: bee.ok,
      note: bee.ok
        ? "Stealth proxy defeats the review-directory bot walls (measured: 948KB of real HTML from G2 where the default mode got a 2.5KB challenge page)."
        : bee.reason,
    },
    scrapebadger: {
      available: badger.ok,
      note: badger.ok
        ? "POST /v1/web/scrape. Carries volume (998 credits, free tier). Declines hard bot walls with 422 blocking_page_detected, and is throttled to 5 requests/minute."
        : badger.reason,
    },
  };
}

module.exports = { fetchPage, routeStatus, badgerStatus, looksBlocked, CHALLENGE, KNOWN_WALLED };
