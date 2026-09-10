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

/* ------------------------------------------------------------------ SearXNG */

async function checkSearxng() {
  const searx = require("./lib/searxng-client");
  let p;
  try { p = await searx.probe(); } catch (e) {
    return report("SearXNG", "BROKEN", `probe threw: ${e.message}`,
      { fix: "Start it with: npm run searxng:local" });
  }
  if (!p.ok) {
    return report("SearXNG", "BROKEN", p.reason || "not reachable",
      { fix: "Start it with: npm run searxng:local  (then: npm run searxng:status)" });
  }

  // A probe that returns 200 with zero usable engines is the failure mode that
  // matters most here — it looks healthy and measures nothing.
  const r = await searx.search("Document360 knowledge base", { days: 365 });
  const engines = {};
  for (const x of r.results || []) {
    for (const e of (x.engines || [x.engine]).filter(Boolean)) engines[e] = (engines[e] || 0) + 1;
  }
  const live = Object.keys(engines).length;
  const dead = (r.unresponsive_engines || []).length;

  if (!r.results.length) {
    return report("SearXNG", "BROKEN",
      `reachable but returned 0 results (${dead} engine(s) unresponsive)`,
      { fix: "Upstream engines are rate-limited or CAPTCHA'd. Wait, or run: npm run searxng:engines", engines, unresponsive: r.unresponsive_engines });
  }
  if (live < 3) {
    return report("SearXNG", "DEGRADED",
      `${r.results.length} results from only ${live} engine(s); ${dead} unresponsive`,
      { engines, unresponsive: r.unresponsive_engines });
  }
  report("SearXNG", "WORKING",
    `${r.results.length} results from ${live} engines (${dead} unresponsive: ${(r.unresponsive_engines || []).map(e => Array.isArray(e) ? e[0] : e).join(", ") || "none"})`,
    { engines, unresponsive: r.unresponsive_engines });
}

/* ----------------------------------------------------------------- Octolens */

async function checkOctolens() {
  const key = process.env.OCTOLENS_API_KEY;
  if (!key) return report("Octolens", "BROKEN", "OCTOLENS_API_KEY not set", { fix: "Add OCTOLENS_API_KEY to .env" });

  const ad = require("./adapters/octolens");
  const page = await ad._fetchPage(null);
  if (!page.ok) {
    return report("Octolens", "BROKEN", `API error: ${page.error}`, {
      plan_limited: !!page.plan_limited,
      fix: page.plan_limited
        ? "Octolens API access requires a Pro, Scale or Enterprise plan. The key is valid; the plan does not include API access."
        : "Verify the key in the Octolens dashboard",
    });
  }
  const kws = {};
  for (const m of page.data) for (const k of (m.keywords || [])) kws[k.keyword] = (kws[k.keyword] || 0) + 1;
  const tracked = Object.keys(kws);

  // The coverage limit is the real finding, not the HTTP status.
  const { allBrands } = require("./lib/brands");
  const uncovered = allBrands()
    .filter(b => !tracked.some(k => b.aliases.some(a => k.toLowerCase().includes(a.toLowerCase()))))
    .map(b => b.name);

  report("Octolens", uncovered.length ? "DEGRADED" : "WORKING",
    `${page.data.length} mentions on page 1; watches [${tracked.join(", ") || "none"}]` +
    (uncovered.length ? `; NO coverage for ${uncovered.length}/7: ${uncovered.join(", ")}` : ""),
    {
      tracked_keywords: tracked,
      uncovered_products: uncovered,
      fix: uncovered.length ? "Add these products as keywords in the Octolens dashboard — the API cannot do it." : null,
    });
}

/* ------------------------------------------------------------------ NewsAPI */

async function checkNewsapi() {
  const key = process.env.NEWSAPI_KEY;
  if (!key) return report("NewsAPI", "BROKEN", "NEWSAPI_KEY not set", { fix: "Add NEWSAPI_KEY to .env" });

  const r = await fetchJson(
    "https://newsapi.org/v2/everything?q=%22Document360%22&pageSize=5&sortBy=publishedAt&language=en",
    { headers: { "X-Api-Key": key }, retries: 1, timeout: 30000 }
  );
  if (!r.ok || !r.json) {
    let msg = `HTTP ${r.status}`;
    try { msg = JSON.parse(r.body).message || msg; } catch (e) { /* keep */ }
    return report("NewsAPI", "BROKEN", msg, { fix: "Verify the key at newsapi.org/account" });
  }
  if (r.json.status !== "ok") {
    return report("NewsAPI", "BROKEN", `${r.json.code}: ${r.json.message}`, { fix: "Check plan limits at newsapi.org/account" });
  }
  // The developer plan caps at page 1 (page 2 → HTTP 426), which bounds coverage.
  report("NewsAPI", "DEGRADED",
    `${r.json.totalResults} total results for "Document360", ${(r.json.articles || []).length} returned`,
    {
      total_results: r.json.totalResults,
      note: "Developer plan: only page 1 is retrievable (page 2 returns HTTP 426), and article content is a ~200-char snippet. Both bound coverage.",
    });
}

/* --------------------------------------------------------------- Bright Data */

async function checkBrightData() {
  const bd = require("./lib/brightdata");
  if (!bd.configured()) return report("Bright Data", "BROKEN", "BRIGHTDATA_API_KEY not set", { fix: "Add BRIGHTDATA_API_KEY to .env" });

  const st = await fetchJson("https://api.brightdata.com/status", {
    headers: { Authorization: "Bearer " + process.env.BRIGHTDATA_API_KEY }, retries: 1, timeout: 30000,
  });
  if (!st.ok || !st.json) return report("Bright Data", "BROKEN", `status endpoint HTTP ${st.status}`);

  const rapi = bd.requestApi();
  // The scraper API is what this project actually uses, so prove that rather
  // than only reading /status.
  const t = await bd.trigger(bd.DATASETS.linkedin_posts.id,
    [{ url: "https://www.linkedin.com/posts/document360_apidocumentation-apis-developerexperience-activity-7497949284437344256-OMya" }]);

  if (!t.ok) {
    return report("Bright Data", "BROKEN", `scraper trigger failed: ${String(t.error).slice(0, 80)}`,
      { fix: "Check the Bright Data account is active and the dataset is accessible" });
  }
  report("Bright Data", rapi.available ? "WORKING" : "DEGRADED",
    `Web Scraper API works (snapshot ${t.snapshot_id}); /request API ${rapi.available ? `available (zone ${rapi.zone})` : "UNAVAILABLE — no zone provisioned"}`,
    {
      customer: st.json.customer,
      scraper_ok: true,
      request_api: rapi.available,
      fix: rapi.available ? null : "Create a SERP API or Web Unlocker zone in the Bright Data control panel, then: npm run brightdata:probe",
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
  const st = require("./lib/scrape").routeStatus();
  const up = Object.entries(st).filter(([, v]) => v.available).map(([k]) => k);
  const down = Object.entries(st).filter(([, v]) => !v.available).map(([k]) => k);
  // One available route is enough to scrape; the chain exists so a dead
  // provider costs an attempt rather than a channel.
  report(up.length ? (down.length ? "DEGRADED" : "WORKING") : "FAIL", "scraping chain",
    `${up.join(" -> ")} available` + (down.length ? `; unavailable: ${down.join(", ")}` : ""),
    {
      routes: st,
      fix: st.scrapebadger.needs_dashboard_setup
        ? "ScrapeBadger: create a scraper in their dashboard, then set SCRAPEBADGER_SCRAPER to its name."
        : null,
    });
}

/* ------------------------------------------------------------------ Windsor */

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
    ["SearXNG", checkSearxng],
    ["Octolens", checkOctolens],
    ["NewsAPI", checkNewsapi],
    ["Bright Data", checkBrightData],
    ["DataForSEO", checkDataForSeo],
    ["Scraping chain", checkScraping],
    ["Windsor.ai", checkWindsor],
    ["Claude runtime", checkClaudeRuntime],
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
