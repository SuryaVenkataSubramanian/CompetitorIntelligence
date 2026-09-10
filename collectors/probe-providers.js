#!/usr/bin/env node
/**
 * Capability probe for every data provider.
 *
 *   npm run probe:providers
 *
 * WHY PROBE RATHER THAN READ THE DOCS
 * -----------------------------------
 * Every provider in this project has behaved differently from its
 * documentation in a way that mattered:
 *
 *   Bright Data   /datasets/v3/list 404s; the working path is /datasets/list.
 *                 Then the account suspended mid-session.
 *   DataForSEO    enforces 6 req/min and reports the breach INSIDE an HTTP 200,
 *                 so it does not look like a failure.
 *   Windsor.ai    rejects `total_users` alongside `session_source_medium` with
 *                 a 400 that an earlier version read as "no data".
 *   SearXNG       returns HTTP 200 with zero usable engines when suspended.
 *
 * So each provider is asked directly what it can do, and the answer is written
 * to collectors/store/provider-capabilities.json for adapters to read. A
 * capability that is absent is reported as unavailable — never as zero.
 */
const fs = require("fs");
const path = require("path");
const { load } = require("./lib/env");
const { fetchUrl, fetchJson } = require("./lib/fetch");

load();

const OUT = path.join(__dirname, "store", "provider-capabilities.json");
const results = [];

function say(name, state, detail, extra = {}) {
  const mark = { WORKING: "  OK  ", DEGRADED: " WARN ", BROKEN: " FAIL ", SKIPPED: " SKIP " }[state] || state;
  console.log(`[${mark}] ${name.padEnd(22)} ${detail}`);
  results.push({ provider: name, state, detail, ...extra });
}

/* ------------------------------------------------------------------ SerpAPI */

async function probeSerpApi() {
  const key = process.env.SERPAPI_KEY;
  if (!key) return say("SerpAPI", "BROKEN", "SERPAPI_KEY not set");

  // Account first: it reports the plan and remaining searches, and costs none.
  const acct = await fetchJson(`https://serpapi.com/account?api_key=${key}`, { retries: 1, timeout: 30000 });
  if (!acct.ok || !acct.json) {
    return say("SerpAPI", "BROKEN", `account check failed: HTTP ${acct.status} ${(acct.body || "").slice(0, 80)}`);
  }
  const a = acct.json;
  const left = a.total_searches_left ?? a.plan_searches_left ?? null;

  // A real query, to confirm the search path and see what shape comes back.
  const q = await fetchJson(
    `https://serpapi.com/search?engine=google&q=${encodeURIComponent("site:linkedin.com/posts Document360")}&num=20&api_key=${key}`,
    { retries: 1, timeout: 45000, maxBytes: 16 * 1024 * 1024 }
  );
  const organic = (q.json && q.json.organic_results) || [];
  const err = q.json && q.json.error;

  say("SerpAPI", left === 0 ? "DEGRADED" : "WORKING",
    `plan ${a.plan_name || "?"}, ${left ?? "?"} searches left; site: query returned ${organic.length} result(s)` +
    (err ? ` (error: ${String(err).slice(0, 60)})` : ""),
    {
      plan: a.plan_name || null,
      searches_left: left,
      searches_used_this_month: a.this_month_usage ?? null,
      site_operator_works: organic.length > 0,
      sample: organic.slice(0, 3).map(r => r.link),
      error: err || null,
    });
}

/* ------------------------------------------------------------ twitterapi.io */

async function probeTwitterApiIo() {
  const key = process.env.TWITTERAPI_IO_KEY;
  const userId = process.env.TWITTERAPI_IO_USER_ID;

  if (!key) {
    return say("twitterapi.io", "BROKEN",
      `no API key. TWITTERAPI_IO_USER_ID=${userId || "unset"} is present, but the value supplied for the key was the user ID repeated`,
      {
        needs: "TWITTERAPI_IO_KEY",
        how: "Copy the API key from the twitterapi.io dashboard — it is a separate value from the user ID.",
      });
  }

  // Documented shape: X-API-Key header, /twitter/user/last_tweets?userName=…
  const r = await fetchJson(
    "https://api.twitterapi.io/twitter/user/last_tweets?userName=document360",
    { headers: { "X-API-Key": key }, retries: 1, timeout: 40000 }
  );
  if (!r.ok || !r.json) {
    return say("twitterapi.io", "BROKEN", `HTTP ${r.status} ${(r.body || "").slice(0, 100)}`);
  }
  const tweets = (r.json.data && (r.json.data.tweets || r.json.data)) || r.json.tweets || [];
  const n = Array.isArray(tweets) ? tweets.length : 0;
  say("twitterapi.io", n ? "WORKING" : "DEGRADED",
    `${n} tweet(s) for @document360`,
    { tweets: n, keys: Object.keys(r.json).slice(0, 8), sample: Array.isArray(tweets) ? tweets.slice(0, 2) : null });
}

/* ------------------------------------------------------------- ScrapingBee */

async function probeScrapingBee() {
  const key = process.env.SCRAPINGBEE_KEY;
  if (!key) return say("ScrapingBee", "BROKEN", "SCRAPINGBEE_KEY not set");

  // Usage endpoint first — it reports the credit balance without spending one.
  const usage = await fetchJson(`https://app.scrapingbee.com/api/v1/usage?api_key=${key}`, { retries: 1, timeout: 30000 });
  const u = usage.json || {};

  // Then a real fetch of a bot-walled page, which is the whole reason to use it.
  const target = "https://www.g2.com/categories/knowledge-base";
  const r = await fetchUrl(
    `https://app.scrapingbee.com/api/v1/?api_key=${key}&url=${encodeURIComponent(target)}&render_js=false`,
    { retries: 0, timeout: 90000, maxBytes: 8 * 1024 * 1024 }
  );
  const walled = /captcha|are you a robot|access denied|cf-browser-verification/i.test(r.body || "");
  say("ScrapingBee",
    r.ok && !walled ? "WORKING" : r.ok ? "DEGRADED" : "BROKEN",
    `credits ${u.used_api_credit ?? "?"}/${u.max_api_credit ?? "?"}; G2 fetch HTTP ${r.status}, ${r.bytes} bytes${walled ? " (still bot-walled)" : ""}`,
    {
      used_api_credit: u.used_api_credit ?? null,
      max_api_credit: u.max_api_credit ?? null,
      g2_status: r.status,
      g2_bytes: r.bytes,
      defeats_bot_wall: r.ok && !walled,
    });
}

/* ------------------------------------------------------------ ScrapeBadger */

async function probeScrapeBadger() {
  const key = process.env.SCRAPEBADGER_KEY;
  if (!key) return say("ScrapeBadger", "BROKEN", "SCRAPEBADGER_KEY not set");

  /* No published base path was supplied, so the common shapes are tried and
   * whichever answers is recorded. Guessing one and hard-coding it is how an
   * integration ends up silently returning nothing. */
  const target = "https://example.com";
  const candidates = [
    ["GET  /v1/scrape?url=",     `https://api.scrapebadger.com/v1/scrape?api_key=${key}&url=${encodeURIComponent(target)}`],
    ["GET  /scrape?url=",        `https://api.scrapebadger.com/scrape?api_key=${key}&url=${encodeURIComponent(target)}`],
    ["GET  /v1/?url= (bearer)",  `https://api.scrapebadger.com/v1/?url=${encodeURIComponent(target)}`],
    ["GET  /account",            `https://api.scrapebadger.com/v1/account?api_key=${key}`],
  ];

  const tried = [];
  let working = null;
  for (const [label, url] of candidates) {
    const headers = label.includes("bearer")
      ? { Authorization: `Bearer ${key}`, "X-API-Key": key }
      : {};
    const r = await fetchUrl(url, { headers, retries: 0, timeout: 40000 });
    const real = r.ok && /Example Domain/i.test(r.body || "");
    tried.push({ shape: label.trim(), status: r.status, bytes: r.bytes, returned_target: real, body: (r.body || "").slice(0, 120) });
    if (real && !working) working = label.trim();
    if (working) break;
  }

  if (working) {
    say("ScrapeBadger", "WORKING", `endpoint shape: ${working}`, { endpoint: working, tried });
  } else {
    const statuses = tried.map(t => `${t.shape} → ${t.status}`).join("; ");
    say("ScrapeBadger", "BROKEN",
      `no tried endpoint returned the target page. ${statuses}`,
      { tried, note: "The base URL and path were not supplied; these are the shapes attempted." });
  }
}

/* -------------------------------------------------- already-integrated ones */

async function probeExisting() {
  // Bright Data: was working this morning, suspended by afternoon.
  try {
    const r = await fetchJson("https://api.brightdata.com/status", {
      headers: { Authorization: "Bearer " + process.env.BRIGHTDATA_API_KEY }, retries: 1, timeout: 30000,
    });
    const j = r.json || {};
    say("Bright Data", j.status === "active" ? "WORKING" : "BROKEN",
      `account ${j.status || "?"}, can_make_requests=${j.can_make_requests}`,
      { status: j.status || null, fix: j.status === "suspended" ? "Reactivate the account in the Bright Data console." : null });
  } catch (e) { say("Bright Data", "BROKEN", String(e.message).slice(0, 70)); }

  // DataForSEO: metered, and the balance ran down mid-session.
  try {
    const dfs = require("./lib/dataforseo");
    const b = await dfs.balance();
    const min = Number(process.env.DATAFORSEO_MIN_BALANCE || 0.05);
    say("DataForSEO", !b.ok ? "BROKEN" : b.balance <= min ? "BROKEN" : b.balance < 0.5 ? "DEGRADED" : "WORKING",
      b.ok ? `balance $${Number(b.balance).toFixed(4)} (reserve $${min})` : String(b.reason).slice(0, 70),
      { balance: b.ok ? b.balance : null, fix: b.ok && b.balance <= min ? "Top up the DataForSEO account." : null });
  } catch (e) { say("DataForSEO", "BROKEN", String(e.message).slice(0, 70)); }

  // SearXNG: free, local, and the current fallback for everything.
  try {
    const s = await require("./lib/searxng-client").probe();
    say("SearXNG", s.ok ? "WORKING" : "BROKEN",
      s.ok ? String(s.detail).slice(0, 90) : String(s.reason).slice(0, 90),
      { fix: s.ok ? null : "Start it: npm run searxng:local" });
  } catch (e) { say("SearXNG", "BROKEN", String(e.message).slice(0, 70)); }
}

/* ---------------------------------------------------------------------- run */

(async () => {
  console.log("\n  Provider capability probe\n");

  for (const [name, fn] of [
    ["SerpAPI", probeSerpApi],
    ["twitterapi.io", probeTwitterApiIo],
    ["ScrapingBee", probeScrapingBee],
    ["ScrapeBadger", probeScrapeBadger],
  ]) {
    try { await fn(); } catch (e) { say(name, "BROKEN", `probe threw: ${String(e.message).slice(0, 70)}`); }
  }
  console.log("");
  await probeExisting();

  const by = results.reduce((a, r) => { a[r.state] = (a[r.state] || 0) + 1; return a; }, {});
  console.log(`\n  ${Object.entries(by).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(" · ")}`);

  const fixes = results.filter(r => r.fix || r.needs);
  if (fixes.length) {
    console.log("\n  Needs action:");
    for (const f of fixes) console.log(`    ${f.provider}: ${f.fix || f.how || f.needs}`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ probed_at: new Date().toISOString(), providers: results }, null, 2));
  console.log(`\n  written: collectors/store/provider-capabilities.json\n`);
})();
