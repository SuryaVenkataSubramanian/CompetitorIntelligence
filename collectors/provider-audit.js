#!/usr/bin/env node
/**
 * Deep provider audit — does each integration still earn its place?
 *
 *   npm run audit:providers
 *   npm run audit:providers -- --json
 *
 * WHY THIS IS DIFFERENT FROM api-health.js
 * ----------------------------------------
 * api-health.js answers "is it up right now". That is an operational question
 * and it is asked every run. This asks a harder one, which nobody asks often
 * enough: SHOULD THIS INTEGRATION STILL EXIST?
 *
 * Those come apart in ways that matter. NewsAPI is UP — the key authenticates,
 * the endpoint answers 200 — and it returns one result for a brand that
 * DuckDuckGo returns fifty for. A health check says WORKING. An audit says this
 * costs a config key, a retry path and a line of everyone's attention, and
 * contributes nothing a free source is not already providing better.
 *
 * So every provider is graded on FOUR axes, in this order, because a failure at
 * any level makes the ones below it irrelevant:
 *
 *   1. CONFIGURED   is a credential present at all?
 *   2. AUTHENTICATES does the credential still work?
 *   3. FUNDED       is there quota/balance left to actually call it?
 *   4. VALUABLE     does it return something no cheaper source already gives us?
 *
 * The fourth is the one that gets skipped, and it is the reason this file
 * exists. An integration that passes 1-3 and fails 4 is technical debt wearing
 * a green tick.
 *
 * VERDICTS
 *   KEEP            working and contributing something distinct
 *   RECHARGE        the integration is sound, the account is empty
 *   FIX             credential or protocol problem that code can address
 *   REMOVE          no valid call protocol, no key, or no value over free
 *   REMOVE_CODE     dead code: an adapter that has never once collected
 *
 * Nothing here deletes anything. It produces the evidence; removal is a
 * separate, deliberate commit.
 */
const fs = require("fs");
const path = require("path");
const { load } = require("./lib/env");
const { fetchUrl, fetchJson } = require("./lib/fetch");

load();

const JSON_ONLY = process.argv.includes("--json");
const results = [];

function say(...a) { if (!JSON_ONLY) console.log(...a); }

/**
 * @param {object} r
 *   id, label, purpose        what it is for
 *   unique_value              what ONLY it provides (null = nothing unique)
 *   configured/authenticates/funded/valuable   the four axes
 *   verdict, reason, action
 */
function record(r) {
  results.push(r);
  const mark = {
    KEEP: "  KEEP  ", RECHARGE: "RECHARGE", FIX: "  FIX   ",
    REMOVE: " REMOVE ", REMOVE_CODE: " REMOVE ",
  }[r.verdict] || r.verdict;
  say(`[${mark}] ${r.label.padEnd(24)} ${r.reason}`);
}

/* ------------------------------------------------------------------ axes */

function axes(configured, authenticates, funded, valuable) {
  return { configured, authenticates, funded, valuable };
}

/* ====================================================== metered providers */

async function auditDataForSeo() {
  const id = "dataforseo";
  const label = "DataForSEO";
  const purpose = "The only source that can measure ChatGPT, Claude, Gemini, Perplexity and Google AI Overview answers.";
  const unique = "AI answer visibility across all 6 surfaces. Nothing else here can do this at all.";

  if (!process.env.DATAFORSEO_B64) {
    return record({
      id, label, purpose, unique_value: unique,
      ...axes(false, null, null, null),
      verdict: "REMOVE", reason: "DATAFORSEO_B64 not set — AI visibility cannot be measured by anything else",
      action: "Either set the key or accept that the AI Visibility tab reports not-measured.",
    });
  }

  const dfs = require("./lib/dataforseo");
  const bal = await dfs.balance();
  if (!bal.ok) {
    return record({
      id, label, purpose, unique_value: unique,
      ...axes(true, false, null, null),
      verdict: "FIX", reason: `credential present but the balance call failed: ${String(bal.reason).slice(0, 70)}`,
      action: "Re-check the login:password pair at dataforseo.com.",
    });
  }

  const minBal = Number(process.env.DATAFORSEO_MIN_BALANCE || 0.05);
  const perProbe = dfs.estimateProbeCost({}).total;
  const probes = Math.floor(Math.max(0, bal.balance - minBal) / perProbe);
  const funded = probes >= 1;

  record({
    id, label, purpose, unique_value: unique,
    ...axes(true, true, funded, true),
    balance: bal.balance,
    verdict: funded ? "KEEP" : "RECHARGE",
    reason: funded
      ? `$${bal.balance.toFixed(4)} — about ${probes} full 6-surface probe(s) left`
      : `$${bal.balance.toFixed(4)} cannot fund one probe ($${perProbe.toFixed(4)}). IRREPLACEABLE: no other provider measures AI answers.`,
    action: funded ? null : "Top up. Until then AI Visibility reports not-measured, which is correct but empty.",
  });
}

async function auditSerpApi() {
  const id = "serpapi";
  const label = "SerpAPI";
  const purpose = "Real Google SERP over plain HTTP, from anywhere.";
  const unique = "The ONLY route to LinkedIn: it honours site:linkedin.com/posts. DuckDuckGo refuses site: outright and Bright Data is suspended.";

  const serpapi = require("./lib/serpapi");
  if (!serpapi.configured()) {
    return record({
      id, label, purpose, unique_value: unique,
      ...axes(false, null, null, null),
      verdict: "FIX", reason: "SERPAPI_KEY not set — the LinkedIn channel has no route without it",
      action: "Add SERPAPI_KEY.",
    });
  }
  const p = await serpapi.probe();
  if (!p.ok) {
    return record({
      id, label, purpose, unique_value: unique,
      ...axes(true, false, null, null),
      verdict: "FIX", reason: String(p.reason).slice(0, 90), action: "Check the key at serpapi.com.",
    });
  }
  const left = p.searches_left;
  const funded = left == null || left > 0;
  record({
    id, label, purpose, unique_value: unique,
    ...axes(true, true, funded, true),
    quota_left: left,
    verdict: funded ? "KEEP" : "RECHARGE",
    reason: funded
      ? `${left} search(es) left this month. Sole LinkedIn route, 1 search per brand per sweep.`
      : "monthly quota spent — the LinkedIn channel reports unavailable until it resets",
    action: funded ? null : "Wait for the monthly reset or upgrade the plan.",
  });
}

async function auditScrapingBee() {
  const id = "scrapingbee";
  const label = "ScrapingBee";
  const purpose = "JS-rendering scraper with a stealth proxy.";
  const unique = "The only route that defeats the review-directory bot walls (G2, Capterra) AND DuckDuckGo's block page from a datacentre IP. Measured on G2: default HTTP 500, premium a 2.5KB challenge, stealth 948KB of real HTML.";

  if (!process.env.SCRAPINGBEE_KEY) {
    return record({
      id, label, purpose, unique_value: unique,
      ...axes(false, null, null, null),
      verdict: "FIX", reason: "SCRAPINGBEE_KEY not set — no route past any bot wall",
      action: "Add SCRAPINGBEE_KEY.",
    });
  }
  const u = await fetchJson(`https://app.scrapingbee.com/api/v1/usage?api_key=${process.env.SCRAPINGBEE_KEY}`,
    { retries: 1, timeout: 25000 });
  if (!u.ok || !u.json) {
    return record({
      id, label, purpose, unique_value: unique,
      ...axes(true, false, null, null),
      verdict: "FIX", reason: `usage endpoint HTTP ${u.status}`, action: "Check the key at scrapingbee.com.",
    });
  }
  const left = (u.json.max_api_credit ?? 0) - (u.json.used_api_credit ?? 0);
  record({
    id, label, purpose, unique_value: unique,
    ...axes(true, true, left > 0, true),
    credits_left: left,
    verdict: left > 0 ? "KEEP" : "RECHARGE",
    reason: left > 0
      ? `${left} credit(s) of ${u.json.max_api_credit} left`
      : "credits exhausted — review directories and DuckDuckGo become unreachable, and report gaps rather than zeroes",
    action: left > 0 ? null : "Top up, or accept those sources reporting unavailable.",
  });
}

async function auditScrapeBadger() {
  const id = "scrapebadger";
  const label = "ScrapeBadger";
  const purpose = "Bulk scraping, intended to carry volume so ScrapingBee's scarcer credits are saved for hard pages.";
  const unique = null; // ScrapingBee does everything it does, and more.

  if (!process.env.SCRAPEBADGER_KEY) {
    return record({
      id, label, purpose, unique_value: unique,
      ...axes(false, null, null, false),
      verdict: "REMOVE", reason: "no key, and ScrapingBee covers every page it could fetch",
      action: "Drop SCRAPEBADGER_KEY from .env and the route from lib/scrape.js.",
    });
  }
  const scrape = require("./lib/scrape");
  const acct = await scrape.badgerAccount();
  if (!acct.ok) {
    return record({
      id, label, purpose, unique_value: unique,
      ...axes(true, false, null, false),
      verdict: "FIX", reason: `account check failed: ${String(acct.reason).slice(0, 70)}`,
      action: "Verify the key at scrapebadger.com.",
    });
  }
  const credits = acct.credits ?? 0;
  record({
    id, label, purpose, unique_value: unique,
    ...axes(true, true, credits > 0, credits > 0),
    credits_left: credits,
    verdict: credits > 0 ? "KEEP" : "RECHARGE",
    reason: credits > 0
      ? `${credits} credit(s), tier ${acct.tier}. Carries bulk so ScrapingBee is spent only on hard pages.`
      : `0 credits (tier ${acct.tier}). It also DECLINES bot walls with 422, so it never covered the pages ScrapingBee is needed for. Zero-credit value: nil.`,
    action: credits > 0 ? null : "Recharge, or remove it: the chain is direct -> ScrapingBee without it, which is what it has effectively been.",
  });
}

async function auditTwitterApiIo() {
  const id = "twitterapi_io";
  const label = "twitterapi.io";
  const purpose = "X/Twitter keyword search and timelines without an account login.";
  const unique = "The only working route to X. x_twikit needed real credentials and never collected once; Bright Data's X dataset died with the account and had no keyword search anyway.";

  const adapter = require("./adapters/x-twitterapi");
  const cred = adapter.credentialStatus();
  if (!cred.ok) {
    return record({
      id, label, purpose, unique_value: unique,
      ...axes(false, null, null, null),
      verdict: "FIX", reason: cred.reason, action: cred.how_to_enable,
    });
  }
  const c = await adapter.credits();
  if (!c.ok) {
    return record({
      id, label, purpose, unique_value: unique,
      ...axes(true, false, null, null),
      verdict: "FIX", reason: c.reason, action: "Check the key at twitterapi.io.",
    });
  }
  record({
    id, label, purpose, unique_value: unique,
    ...axes(true, true, !c.exhausted, true),
    credits: c.credits,
    verdict: c.exhausted ? "RECHARGE" : "KEEP",
    reason: c.exhausted
      ? `${c.credits} credits — the balance goes NEGATIVE rather than stopping at zero, and every endpoint answers HTTP 402. The X channel is unavailable, not empty.`
      : `${c.credits} credit(s)`,
    action: c.exhausted ? "Recharge at twitterapi.io, or accept X reporting unavailable." : null,
  });
}

async function auditWindsor() {
  const id = "windsor";
  const label = "Windsor.ai";
  const purpose = "GA4 for our own properties — the OUTCOME side of AI visibility.";
  const unique = "First-party traffic that actually arrived from an AI assistant. No competitor-facing source can measure this; it is our own analytics.";

  const windsor = require("./lib/windsor");
  if (!windsor.configured()) {
    return record({
      id, label, purpose, unique_value: unique,
      ...axes(false, null, null, null),
      verdict: "FIX", reason: windsor.credentialStatus().reason, action: "Add WINDSOR_API_KEY.",
    });
  }
  let r;
  try { r = await windsor.aiReferrals({ datePreset: "last_30d" }); }
  catch (e) {
    return record({
      id, label, purpose, unique_value: unique, ...axes(true, false, null, null),
      verdict: "FIX", reason: `threw: ${e.message}`, action: "Check the key at windsor.ai.",
    });
  }
  // ai_sessions is top-level on the Windsor payload. Reading it from a
  // non-existent `.totals` returned undefined -> 0, and this audit reported a
  // healthy integration as broken. An audit that lies about a provider is worse
  // than no audit, because someone acts on it.
  const sessions = (r && r.ai_sessions) || 0;
  const totalSessions = (r && r.total_sessions) || 0;
  record({
    id, label, purpose, unique_value: unique,
    ...axes(true, !!(r && r.ok !== false), true, sessions > 0),
    ai_sessions_30d: sessions,
    verdict: sessions > 0 ? "KEEP" : "FIX",
    reason: sessions > 0
      ? `${sessions} AI-assistant session(s) of ${totalSessions} in 30d — free to query, so it also covers when DataForSEO is dry`
      : "authenticates but returned no AI-referral sessions",
    action: sessions > 0 ? null : "Check the GA4 property is still connected in Windsor.",
  });
}

/* =========================================== providers under suspicion */

async function auditSearxng() {
  const id = "searxng";
  const label = "SearXNG";
  const purpose = "Self-hosted metasearch: one HTTP GET returning results from many engines.";
  const unique = "Aggregates engines behind one maintained parser, and its instance IP is not the one DuckDuckGo has blocked.";

  const searx = require("./lib/searxng-client");
  let p;
  try { p = await searx.probe(); } catch (e) { p = { ok: false, reason: String(e.message || e) }; }

  record({
    id, label, purpose, unique_value: unique,
    ...axes(!!process.env.SEARXNG_URL, p.ok, true, p.ok),
    url: process.env.SEARXNG_URL || null,
    verdict: p.ok ? "KEEP" : "FIX",
    reason: p.ok
      ? `${p.detail} — used as a plain search endpoint, nothing more`
      : `not reachable at ${process.env.SEARXNG_URL || "(unset)"}: ${String(p.reason).slice(0, 70)}. It is OPTIONAL — the keyless layer is the floor — but it is the cheapest way to get search results without a blocked IP.`,
    action: p.ok ? null : "Start it: npm run searxng:local (Docker) — or leave it off and accept DuckDuckGo needing a proxy.",
  });
}


/* ============================================== providers already removed */

/**
 * Removed on 2026-09-18 after this audit. Each verdict came from a call
 * through the adapter's own code path, not from a hand-written probe.
 */
const REMOVED = [
  {
    id: "octolens", label: "Octolens", purpose: "social listening", unique_value: null,
    configured: true, authenticates: false, funded: false, valuable: false,
    verdict: "REMOVE", removed: true,
    reason: "REMOVED. The key is valid; the API answers HTTP 403 — access is not on this plan. No call protocol exists to fix in code.",
    action: "Re-add only if the account is upgraded to Pro, Scale or Enterprise.",
  },
  {
    id: "newsapi", label: "NewsAPI", purpose: "news mentions", unique_value: null,
    configured: true, authenticates: true, funded: true, valuable: false,
    verdict: "REMOVE", removed: true,
    reason: "REMOVED. It authenticated and answered — and returned the same single result that free Google News RSS returns for the same brand. The developer plan also caps retrieval at page 1 and truncates content to ~200 chars. Up, and contributing nothing.",
    action: "Google News RSS covers this. Re-add only if the plan changes.",
  },
  {
    id: "brightdata", label: "Bright Data", purpose: "LinkedIn / X / Reddit scraping", unique_value: null,
    configured: true, authenticates: true, funded: false, valuable: false,
    verdict: "REMOVE", removed: true,
    reason: "REMOVED. /status answers HTTP 200, but the scraper trigger both adapters depended on fails with \"Customer is not active\". Reading works; collecting does not.",
    action: "LinkedIn is served by SerpAPI, X by twitterapi.io. Re-add only if the account is reactivated.",
  },
];

/* ====================================================== keyless sources A-K */

async function auditKeyless() {
  const fresh = require("./lib/freshsources");
  say("\n  Keyless sources (A-K) — the freshness floor, live:\n");

  const r = await fresh.sweep({ brands: ["document360", "mintlify"], sinceDays: 7, log: () => {} });

  for (const p of r.per_source) {
    const gaps = r.gaps.filter(g => g.source === p.id);
    // A source returning 0 is NOT broken — a quiet week is a real answer. Only
    // a source that threw, or reported a gap, could not be asked.
    const blocked = !p.ok || gaps.length > 0;
    record({
      id: p.id, label: p.label, purpose: "keyless source", unique_value: null,
      ...axes(true, p.ok, true, p.candidates > 0),
      tier: p.tier,
      candidates: p.candidates,
      seconds: p.seconds,
      verdict: p.ok ? "KEEP" : "FIX",
      reason: `${p.candidates} candidate(s) in ${p.seconds}s` +
        (blocked ? ` — ${String((gaps[0] && gaps[0].reason) || p.error).slice(0, 90)}` : "") +
        (p.candidates === 0 && !blocked ? " — genuine zero, the source answered and had nothing" : ""),
      action: p.ok ? null : `Investigate: ${String(p.error).slice(0, 90)}`,
    });
  }
  return r;
}

/* ================================================== dead code (no protocol) */

function auditDeadCode() {
  say("\n  Adapters with no valid call protocol:\n");

  const collectSrc = fs.readFileSync(path.join(__dirname, "collect.js"), "utf8");
  const DEAD = [
    {
      id: "x_twikit", file: "adapters/x_twikit.js",
      why: "Drives a real X account with a username and password. It has NEVER collected once: the credential is a personal login that cannot go to a hosted deployment, and the flow dies on a CAPTCHA or 2FA prompt.",
    },
    {
      id: "linkedin", file: "adapters/linkedin.js",
      why: "Needs a li_at session cookie from a real LinkedIn login. Same problem, same result: dormant since written, reporting 'not connected' forever.",
    },
    {
      id: "x_brightdata", file: "adapters/x-brightdata.js",
      why: "Bright Data's X dataset. Worked for one afternoon, then the account suspended. Profile-only — it never had keyword search, so it could not see a stranger complaining about us.",
    },
    {
      id: "linkedin_brightdata", file: "adapters/linkedin-brightdata.js",
      why: "Bright Data's LinkedIn dataset. Dark since the account suspended. SerpAPI's site: query replaces it.",
    },
  ];

  for (const d of DEAD) {
    const p = path.join(__dirname, d.file);
    const exists = fs.existsSync(p);
    const registered = collectSrc.includes(`adapters/${d.id.replace(/_/g, "-")}`) ||
      new RegExp(`adapters/${d.id}`).test(collectSrc);
    record({
      id: d.id, label: d.id, purpose: "adapter", unique_value: null,
      ...axes(false, false, false, false),
      file: d.file, exists, registered_in_collect: registered,
      verdict: "REMOVE_CODE",
      reason: d.why,
      action: `Delete ${d.file}` + (registered ? " and its entry in collect.js." : " (already unregistered)."),
    });
  }
}

/* --------------------------------------------------------------------- run */

(async () => {
  say("\n  Deep provider audit — configured / authenticates / funded / VALUABLE\n");
  say("  The fourth axis is the one that matters: an integration can be up and");
  say("  still be worth removing.\n");

  const checks = [
    ["DataForSEO", auditDataForSeo],
    ["SerpAPI", auditSerpApi],
    ["ScrapingBee", auditScrapingBee],
    ["ScrapeBadger", auditScrapeBadger],
    ["twitterapi.io", auditTwitterApiIo],
    ["Windsor.ai", auditWindsor],
    ["SearXNG", auditSearxng],
  ];
  for (const [name, fn] of checks) {
    try { await fn(); }
    catch (e) {
      record({
        id: name, label: name, purpose: "?", unique_value: null,
        ...axes(null, null, null, null),
        verdict: "FIX", reason: `audit threw: ${e.message}`, action: "Investigate.",
      });
    }
  }

  /* ALREADY REMOVED. Kept in the report rather than deleted from it, because
   * "we looked at this and took it out, here is the evidence" is a different
   * and more useful statement than silence. A future reader deciding whether
   * to re-add one of these should be able to see why it went. */
  for (const r of REMOVED) record(r);

  let keyless = null;
  try { keyless = await auditKeyless(); }
  catch (e) { say(`  keyless sweep failed: ${e.message}`); }

  auditDeadCode();

  /* ------------------------------------------------------------- summary */
  const by = results.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
  say("\n  " + Object.entries(by).map(([k, v]) => `${v} ${k}`).join(" · "));

  const remove = results.filter(r => r.verdict === "REMOVE" || r.verdict === "REMOVE_CODE");
  if (remove.length) {
    say("\n  REMOVE — no valid call protocol, no key, or no value over a free source:");
    for (const r of remove) say(`    ${r.label.padEnd(22)} ${r.action}`);
  }
  const recharge = results.filter(r => r.verdict === "RECHARGE");
  if (recharge.length) {
    say("\n  RECHARGE — sound integration, empty account (only you can fix these):");
    for (const r of recharge) say(`    ${r.label.padEnd(22)} ${r.reason}`);
  }

  const out = path.join(__dirname, "store", "provider-audit.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    audited_at: new Date().toISOString(),
    summary: by,
    providers: results,
    keyless_sweep: keyless ? { per_source: keyless.per_source, gaps: keyless.gaps } : null,
  }, null, 2));

  if (JSON_ONLY) console.log(JSON.stringify(results, null, 2));
  else console.log(`\n  written: collectors/store/provider-audit.json\n`);
})();
