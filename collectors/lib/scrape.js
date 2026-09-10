/**
 * One scraping entry point, with an explicit fallback chain.
 *
 *   direct fetch  →  ScrapingBee (stealth)  →  ScrapeBadger
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
 *   ScrapingBee   For hosts that refuse a plain request. MEASURED on G2's
 *                 category page: default HTTP 500, premium_proxy a 2.5KB
 *                 challenge page, stealth_proxy 948KB of real HTML with 17
 *                 products. Stealth is the only mode that works there.
 *   ScrapeBadger  Last resort. It is a configure-a-scraper product: the API is
 *                 /api/v1/<scraper-name> for a scraper built in their
 *                 dashboard. There is no generic scrape endpoint — probed
 *                 /scrapers, /list, /account, /me, /jobs, /usage and every one
 *                 answered "Scraper '<name>' is not configured" or 404. So it
 *                 stays INERT until SCRAPEBADGER_SCRAPER names a real scraper,
 *                 and says so rather than silently returning nothing.
 *
 * A 200 CARRYING A CHALLENGE PAGE IS THE DANGEROUS CASE. It looks like success
 * and parses to nothing, which is how a bot wall becomes "this company has no
 * products". Detected here, and treated as a failure so the next route is tried.
 */
const { fetchUrl } = require("./fetch");
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

function badgerConfig() {
  return {
    key: process.env.SCRAPEBADGER_KEY || "",
    scraper: process.env.SCRAPEBADGER_SCRAPER || "",
  };
}

function badgerStatus() {
  const { key, scraper } = badgerConfig();
  if (!key) {
    return { ok: false, reason: "SCRAPEBADGER_KEY is not set." };
  }
  if (!scraper) {
    return {
      ok: false,
      reason:
        "SCRAPEBADGER_SCRAPER is not set. ScrapeBadger has no generic scrape endpoint — its API is " +
        "/api/v1/<scraper-name> for a scraper created in the ScrapeBadger dashboard. Probed " +
        "/scrapers, /list, /account, /me, /jobs and /usage: each returned " +
        '"Scraper \'<name>\' is not configured" or 404. Create a scraper there, then set ' +
        "SCRAPEBADGER_SCRAPER to its name.",
      needs_dashboard_setup: true,
    };
  }
  return { ok: true, scraper };
}

/**
 * Fetch through ScrapeBadger's named scraper.
 *
 * The response shape depends on how the scraper was built in their dashboard,
 * so both a raw-HTML body and a JSON envelope carrying html/content/body are
 * accepted. Anything else is reported rather than guessed at.
 */
async function viaBadger(url, { log = () => {} } = {}) {
  const st = badgerStatus();
  if (!st.ok) return { ok: false, skipped: "not_configured", error: st.reason, via: "scrapebadger" };

  const { key, scraper } = badgerConfig();
  const endpoint =
    `https://scrapebadger.com/api/v1/${encodeURIComponent(scraper)}?url=${encodeURIComponent(url)}`;

  const r = await fetchUrl(endpoint, {
    headers: { Authorization: `Bearer ${key}`, "X-API-Key": key },
    retries: 1,
    timeout: 120000,
    maxBytes: 16 * 1024 * 1024,
  });

  if (!r.ok) {
    // Their free tier is 5 requests/minute and answers a 6th with 429.
    const rateLimited = r.status === 429;
    return {
      ok: false,
      status: r.status,
      error: rateLimited
        ? "ScrapeBadger rate limit (free tier: 5 requests/minute)"
        : `ScrapeBadger HTTP ${r.status}: ${String(r.body || "").replace(/\s+/g, " ").slice(0, 160)}`,
      rate_limited: rateLimited,
      via: `scrapebadger (${scraper})`,
    };
  }

  // A configured scraper may return HTML directly or wrapped in JSON.
  let body = r.body;
  const trimmed = String(body || "").trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const j = JSON.parse(body);
      body = j.html || j.content || j.body || j.data || null;
      if (body && typeof body !== "string") body = JSON.stringify(body);
      if (!body) {
        return {
          ok: false,
          error:
            `ScrapeBadger scraper "${scraper}" returned JSON with no html/content/body field. ` +
            `Keys: ${Object.keys(j).join(", ").slice(0, 120)}. The scraper may be configured to ` +
            `return structured data rather than a page.`,
          via: `scrapebadger (${scraper})`,
        };
      }
    } catch (e) { /* not JSON after all; keep the raw body */ }
  }

  log(`      scrapebadger(${scraper}): ${url.slice(0, 60)} → ${String(body || "").length} chars`);
  return {
    ok: true,
    status: r.status,
    url,
    final_url: url,
    fetched_at: new Date().toISOString(),
    bytes: Buffer.byteLength(String(body || "")),
    content_sha256: r.content_sha256,
    body: String(body || ""),
    via: `scrapebadger (${scraper})`,
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

  /* 2. ScrapingBee — stealth is chosen automatically for the walled hosts. */
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

  /* 3. ScrapeBadger — last resort, inert until a scraper is named. */
  const b = await viaBadger(url, { log });
  if (b.ok && !looksBlocked(b)) {
    return { ...b, attempts };
  }
  attempts.push({
    route: "scrapebadger",
    status: b.status || null,
    skipped: b.skipped || null,
    why: b.error || "returned no usable content",
  });

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
        ? `Configured scraper: ${badger.scraper}`
        : badger.reason,
      needs_dashboard_setup: !!badger.needs_dashboard_setup,
    },
  };
}

module.exports = { fetchPage, routeStatus, badgerStatus, looksBlocked, CHALLENGE, KNOWN_WALLED };
