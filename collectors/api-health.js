#!/usr/bin/env node
/**
 * API health check — every connected data source, verified against the live API.
 *
 *   npm run api:health           check everything (billable calls skipped)
 *   npm run api:health -- --paid also make the cheapest billable calls
 *
 * WHY THIS EXISTS
 * ---------------
 * Every source in this project can fail in a way that looks like "no data":
 * a suspended SearXNG engine, an Octolens account that watches three keywords,
 * a NewsAPI page-2 request that 426s, a Bright Data zone that was never
 * provisioned, a DataForSEO balance that ran out. Each of those produces an
 * empty result, and an empty result is indistinguishable from "nobody mentioned
 * the product" unless something asks the API directly and reports what it said.
 *
 * So this checks each one and prints WORKING / DEGRADED / BROKEN with the
 * evidence. Billable calls are skipped unless --paid is passed, because a health
 * check should not quietly spend money.
 */
const { load } = require("./lib/env");
const { fetchUrl, fetchJson } = require("./lib/fetch");

load();

const PAID = process.argv.includes("--paid");
const results = [];

function report(name, state, detail, extra = {}) {
  results.push({ name, state, detail, ...extra });
  const mark = { WORKING: "  OK  ", DEGRADED: " WARN ", BROKEN: " FAIL ", SKIPPED: " SKIP " }[state] || state;
  console.log(`[${mark}] ${name.padEnd(30)} ${detail}`);
}

/* ------------------------------------------------- keyless sources (the floor)

   THIS IS THE MOST IMPORTANT CHECK IN THE FILE, and it is first for that
   reason. Every metered provider here ran out or switched off inside one week:
   Bright Data suspended, DataForSEO fell to $0.05, Octolens moved API access to
   a paid tier, twitterapi.io went to negative credits. When that happened the
   dashboard did not report an outage — it reported a quiet week, which is the
   same shape and a completely different fact.

   The keyless layer exists so freshness never depends on a billing balance. If
   THIS is healthy the dashboard can still tell you what happened today, whatever
   else is dark. So it is checked per source, live, with the count it returned.
*/

async function checkKeylessSources() {
  const fresh = require("./lib/freshsources");
  const t0 = Date.now();

  // One brand, one week: enough to prove each source answers, cheap enough to
  // run on every health check.
  let r;
  try {
    r = await fresh.sweep({ brands: ["document360"], sinceDays: 7, log: () => {} });
  } catch (e) {
    return report("Keyless sources", "BROKEN", `the sweep threw: ${e.message}`, {
      fix: "This is the freshness floor — everything else is a bonus layer. Investigate before deploying.",
    });
  }

  const per = r.per_source || [];
  const okCount = per.filter(p => p.ok).length;
  const withData = per.filter(p => p.candidates > 0);
  const failed = per.filter(p => !p.ok);
  const total = per.reduce((a, p) => a + p.candidates, 0);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  // A source returning zero is not broken — a quiet week is a real answer. Only
  // a source that THREW or reported a gap is degraded, and the distinction is
  // the whole point of this file.
  const state = okCount === 0 ? "BROKEN" : failed.length ? "DEGRADED" : "WORKING";

  report("Keyless sources", state,
    `${okCount}/${per.length} source(s) answered in ${secs}s; ${withData.length} returned data, ` +
    `${total} candidate(s) for Document360 over 7d` +
    (r.gaps.length ? `; ${r.gaps.length} gap(s) reported` : ""),
    {
      sources: per.map(p => ({ id: p.id, tier: p.tier, candidates: p.candidates, ok: p.ok, error: p.error || null })),
      gaps: r.gaps.slice(0, 10),
      total_candidates: total,
      fix: failed.length
        ? `Failing: ${failed.map(f => f.id).join(", ")}. These need no key, so a failure is a network or markup change, not a billing problem.`
        : null,
    });
}

/* ---------------------------------------------------------------- SerpAPI */

async function checkSerpApi() {
  const serpapi = require("./lib/serpapi");
  if (!serpapi.configured()) {
    return report("SerpAPI", "BROKEN", serpapi.credentialStatus().reason,
      { fix: "Add SERPAPI_KEY to .env." });
  }
  const p = await serpapi.probe();
  if (!p.ok) {
    return report("SerpAPI", "BROKEN", String(p.reason).slice(0, 120),
      { fix: "Check the key and the monthly quota at serpapi.com." });
  }
  const left = p.searches_left;
  // LinkedIn has no other route: Bright Data suspended, and DuckDuckGo refuses
  // site: outright. So a spent SerpAPI quota means the LinkedIn channel stops,
  // and that consequence is named here rather than left to be discovered.
  const state = left === 0 ? "BROKEN" : left < 25 ? "DEGRADED" : "WORKING";
  report("SerpAPI", state,
    `${p.detail}. It is the ONLY route to LinkedIn (site: operator), at one search per brand per sweep.`,
    {
      searches_left: left,
      serves: ["linkedin"],
      fix: left < 25 ? "Fewer than 25 searches left this month. When it hits zero the LinkedIn channel reports unavailable rather than zero." : null,
    });
}

/* ------------------------------------------------------------ twitterapi.io */

async function checkTwitterApi() {
  const adapter = require("./adapters/x-twitterapi");
  const cred = adapter.credentialStatus();
  if (!cred.ok) {
    return report("twitterapi.io (X)", "BROKEN", cred.reason, { fix: cred.how_to_enable });
  }
  let c;
  try { c = await adapter.credits(); } catch (e) {
    return report("twitterapi.io (X)", "BROKEN", `credit check threw: ${e.message}`);
  }
  if (!c.ok) {
    return report("twitterapi.io (X)", "BROKEN", c.reason,
      { fix: "Check the key at twitterapi.io." });
  }
  // MEASURED: the balance goes NEGATIVE rather than stopping at zero, and every
  // endpoint then answers 402. Without this check that reads as four per-brand
  // failures instead of one account-level stop.
  report("twitterapi.io (X)", c.exhausted ? "BROKEN" : c.credits < 500 ? "DEGRADED" : "WORKING",
    `${c.credits} credit(s)` + (c.exhausted ? " — exhausted; every call answers HTTP 402 and the X channel reports unavailable" : ""),
    { credits: c.credits, fix: c.exhausted ? "Recharge at twitterapi.io. Until then the X channel is unavailable, not zero." : null });
}


/* ------------------------------------------------------------------ SearXNG

   SEARXNG IS NOW OPTIONAL, AND REPORTING IT AS BROKEN WAS ITSELF A BUG.

   It was the backbone: web discovery, the directory audit, the Events channel
   and the free SERP fallback all went through it. It is also a local Docker
   service, which means it cannot run on the serverless host the team actually
   opens, and when it stopped those channels went quiet rather than erroring —
   ten days of stale data before anyone noticed.

   The keyless layer replaced it as the freshness floor. So a stopped SearXNG is
   now a missed bonus, not an outage, and this reports SKIPPED rather than
   BROKEN. Calling an optional component "broken" trains people to ignore the
   health check, which is how the genuinely broken row gets missed.
*/

async function checkSearxng() {
  const searx = require("./lib/searxng-client");
  let p;
  try { p = await searx.probe(); } catch (e) {
    p = { ok: false, reason: String(e.message || e) };
  }
  if (p.ok) {
    return report("SearXNG (optional)", "WORKING",
      `${p.detail}. Adds breadth to discovery; nothing depends on it now.`);
  }
  report("SearXNG (optional)", "SKIPPED",
    `not running — ${String(p.reason).slice(0, 90)}. Superseded by the keyless sources above, which need no local service and work on a serverless host.`,
    {
      optional: true,
      superseded_by: "lib/freshsources.js",
      fix: null,
    });
}

/* --------------------------------------------------------------- DataForSEO */

async function checkDataForSeo() {
  const dfs = require("./lib/dataforseo");
  if (!dfs.configured()) {
    return report("DataForSEO", "BROKEN", "DATAFORSEO_B64 not set", { fix: "Add DATAFORSEO_B64 to .env" });
  }
  const b = await dfs.balance();
  if (!b.ok) return report("DataForSEO", "BROKEN", `auth/balance failed: ${b.reason}`, { fix: "Verify the credentials" });

  // Model listings are free, so provider availability can be proven at no cost.
  const avail = [];
  for (const id of ["chatgpt", "claude", "gemini", "perplexity"]) {
    const m = await dfs.models(id);
    avail.push(`${dfs.PROVIDERS[id].label}=${m.ok ? m.models.length : "ERR"}`);
  }

  const minBal = Number(process.env.DATAFORSEO_MIN_BALANCE || 0.05);
  const perProbe = dfs.estimateProbeCost({}).total;
  const probesLeft = Math.floor(Math.max(0, b.balance - minBal) / perProbe);

  const state = b.balance < minBal ? "BROKEN" : probesLeft < 5 ? "DEGRADED" : "WORKING";
  report("DataForSEO", state,
    `balance $${Number(b.balance).toFixed(4)}; models: ${avail.join(", ")}; ~${probesLeft} full 6-surface probe(s) left at $${perProbe.toFixed(4)} each`,
    {
      balance: b.balance,
      per_probe_cost: perProbe,
      probes_remaining: probesLeft,
      spend: dfs.readSpend(),
      fix: probesLeft < 5 ? "Top up the DataForSEO account to keep measuring AI visibility." : null,
    });

  if (PAID) {
    // The cheapest possible real call, to prove the LLM path end to end.
    const r = await dfs.llmResponse("perplexity", "Name three knowledge base tools.", { maxTokens: 200, useCache: false });
    report("DataForSEO live call", r.ok ? "WORKING" : "BROKEN",
      r.ok ? `Perplexity answered ${r.text_length} chars, ${r.citations.length} citations, cost $${r.cost.toFixed(4)}`
        : String(r.error).slice(0, 90));
  } else {
    report("DataForSEO live call", "SKIPPED", "billable — re-run with --paid to verify the LLM path end to end");
  }
}

/* ------------------------------------------------------------- scraping chain */

async function checkScraping() {
  const scrape = require("./lib/scrape");
  const st = scrape.routeStatus();

  /* CONFIGURED IS NOT THE SAME AS USABLE, and this check used to conflate them.
   * It reported "direct -> scrapingbee -> scrapebadger available" purely
   * because both keys were set — while ScrapeBadger was answering
   *   HTTP 402 {"error":"insufficient_credits"}
   * on every request. A route that cannot fetch a page is not an available
   * route, and saying it is turns the fallback chain into a chain of one.
   *
   * So the balances are read. They cost one cheap call each and they are the
   * only thing that distinguishes a working chain from a configured one. */
  const notes = [];
  let badgerOk = false;
  if (st.scrapebadger.available) {
    try {
      const acct = await scrape.badgerAccount();
      badgerOk = acct.ok && (acct.credits == null || acct.credits > 0);
      notes.push(acct.ok
        ? `scrapebadger ${acct.credits == null ? "?" : acct.credits} credit(s)${badgerOk ? "" : " — EXHAUSTED"}`
        : `scrapebadger unreachable (${String(acct.reason).slice(0, 40)})`);
    } catch (e) {
      notes.push(`scrapebadger check threw: ${e.message}`);
    }
  }

  let beeOk = false;
  let beeLeft = null;
  if (st.scrapingbee.available) {
    try {
      const u = await fetchJson(`https://app.scrapingbee.com/api/v1/usage?api_key=${process.env.SCRAPINGBEE_KEY}`,
        { retries: 1, timeout: 25000 });
      if (u.ok && u.json) {
        const used = u.json.used_api_credit;
        const max = u.json.max_api_credit;
        beeLeft = (max != null && used != null) ? max - used : null;
        beeOk = beeLeft == null || beeLeft > 0;
        notes.push(`scrapingbee ${beeLeft == null ? "?" : beeLeft} credit(s) left of ${max}`);
      } else {
        notes.push(`scrapingbee usage HTTP ${u.status}`);
      }
    } catch (e) {
      notes.push(`scrapingbee check threw: ${e.message}`);
    }
  }

  // Direct always works for most of the web; the proxies exist for the rest.
  const usable = ["direct"];
  if (badgerOk) usable.push("scrapebadger");
  if (beeOk) usable.push("scrapingbee");

  // No proxy route means the bot-walled hosts — every review directory, and
  // DuckDuckGo from this network — become unreachable. That is a real
  // degradation even though "direct" still works.
  const state = usable.length >= 3 ? "WORKING" : usable.length === 2 ? "DEGRADED" : "BROKEN";

  report("Scraping chain", state,
    `usable: ${usable.join(" -> ")}` + (notes.length ? `; ${notes.join("; ")}` : ""),
    {
      routes: st,
      usable,
      scrapingbee_credits_left: beeLeft,
      fix: usable.length < 3
        ? "A proxy route is the only way past the review-directory bot walls and DuckDuckGo's block page. " +
          "With none, those sources report unavailable rather than zero. Top up whichever is exhausted."
        : null,
    });
}

async function checkWindsor() {
  const windsor = require("./lib/windsor");
  if (!windsor.configured()) {
    return report("Windsor.ai", "BROKEN", "WINDSOR_API_KEY not set", { fix: "Add WINDSOR_API_KEY to .env" });
  }

  // GA4 is the one that matters, so prove it rather than only listing connectors.
  const r = await windsor.aiReferrals({ log: () => {} });
  if (!r.ok) {
    return report("Windsor.ai", "BROKEN", String(r.error).slice(0, 90),
      { fix: r.hint || "Check the connected accounts at windsor.ai" });
  }

  const surfaces = (r.surfaces || []).map(s => `${s.label}=${s.sessions}`).join(", ");
  report("Windsor.ai", "WORKING",
    `GA4: ${r.ai_sessions} AI-assistant session(s) of ${r.total_sessions} (${r.ai_share_pct}%) — ${surfaces}`,
    {
      ai_sessions: r.ai_sessions,
      total_sessions: r.total_sessions,
      ai_share_pct: r.ai_share_pct,
      surfaces: (r.surfaces || []).map(s => ({ id: s.id, label: s.label, sessions: s.sessions })),
      note: "First-party only — enriches Document360, says nothing about competitors. Free to query, so this layer survives an exhausted DataForSEO balance.",
    });
}

/* -------------------------------------------------------------- Claude / LLM */

async function checkClaudeRuntime() {
  // Claude Code is the local analysis runtime; there is no endpoint to ping, so
  // the honest check is whether the queue/apply plumbing is present and whether
  // any classification has actually landed.
  const fs = require("fs");
  const path = require("path");
  const store = path.join(__dirname, "store");
  const has = f => fs.existsSync(path.join(store, f));
  let classified = 0, total = 0;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "meta.json"), "utf8"));
    classified = meta.integrity.sentiment_classified;
    total = meta.integrity.verified_records;
  } catch (e) { /* not built */ }

  const pct = total ? Math.round((classified / total) * 100) : 0;
  report("Claude (local runtime)", pct >= 80 ? "WORKING" : "DEGRADED",
    `sentiment classified on ${classified}/${total} records (${pct}%); queue files ${has("pending-sentiment.json") || has("claude-answers.json") ? "present" : "absent"}`,
    { classified, total, pct, fix: pct < 80 ? "Run: npm run queue:sentiment, classify in Claude Code, then npm run apply:sentiment" : null });
}

/* ------------------------------------------------ account-backed collection */

/**
 * Optional by design. Reported so a STALE credential is visible — an expired
 * session cookie returns an empty feed rather than an error, which is how an
 * account-backed channel reports "no mentions" while being completely broken.
 */
async function checkSocialAuth() {
  const social = require("./lib/social-auth");
  const st = social.status();

  if (!st.available_here) {
    return report("Account-backed collection", "SKIPPED",
      "disabled on a hosted deployment by design — a personal session cookie must not live in a Vercel env var",
      { available_here: false });
  }
  const active = st.platforms.filter(p => p.state === "active");
  const stale = st.platforms.filter(p => p.state === "stale");

  report("Account-backed collection",
    stale.length ? "DEGRADED" : "SKIPPED",
    stale.length
      ? `${stale.map(p => p.label).join(", ")} STALE — not being used; an expired session returns an empty feed, not an error`
      : active.length
        ? `${active.map(p => `${p.label} (${p.days_left}d left)`).join(", ")}`
        : "none configured — optional; every channel has a keyless route",
    {
      active: active.map(p => p.platform),
      stale: stale.map(p => p.platform),
      fix: stale.length ? `Refresh: ${stale.map(p => p.how_to_enable).join("  |  ")}` : null,
    });
}

/* -------------------------------------------------------------------- SMTP */

async function checkSmtp() {
  const mailer = require("./lib/mailer");
  const s = mailer.status();
  report("SMTP (digest email)", s.configured ? "WORKING" : "DEGRADED",
    s.configured ? `configured: ${s.host}:${s.port} → ${s.to}` : `not configured (missing ${s.missing.join(", ")}) — digests are stored, not sent`,
    { fix: s.configured ? null : "Add SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM to .env" });
}

/* ---------------------------------------------------------------------- run */

(async () => {
  console.log("\n  API health — every connected source, checked against the live API");
  console.log(`  billable calls: ${PAID ? "ENABLED (--paid)" : "skipped"}\n`);

  const checks = [
    ["SearXNG (optional)", checkSearxng],
    ["Keyless sources", checkKeylessSources],
    ["SerpAPI", checkSerpApi],
    ["twitterapi.io", checkTwitterApi],
    ["DataForSEO", checkDataForSeo],
    ["Scraping chain", checkScraping],
    ["Windsor.ai", checkWindsor],
    ["Claude runtime", checkClaudeRuntime],
    ["Account-backed collection", checkSocialAuth],
    ["SMTP", checkSmtp],
  ];
  for (const [name, fn] of checks) {
    try { await fn(); } catch (e) { report(name, "BROKEN", `check threw: ${e.message}`); }
  }

  const by = results.reduce((a, r) => { a[r.state] = (a[r.state] || 0) + 1; return a; }, {});
  console.log(`\n  ${Object.entries(by).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(" · ")}`);

  const fixes = results.filter(r => r.fix);
  if (fixes.length) {
    console.log("\n  What to do:");
    for (const f of fixes) console.log(`    ${f.name}: ${f.fix}`);
  }

  // Machine-readable, so /api/status and the Data Quality tab can show this.
  const fs = require("fs");
  const path = require("path");
  const out = path.join(__dirname, "store", "api-health.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    checked_at: new Date().toISOString(),
    paid_calls: PAID,
    summary: by,
    sources: results,
  }, null, 2));
  console.log(`\n  written: collectors/store/api-health.json\n`);

  process.exit(results.some(r => r.state === "BROKEN") ? 1 : 0);
})();
