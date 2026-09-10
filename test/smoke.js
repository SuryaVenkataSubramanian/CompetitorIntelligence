/**
 * Smoke test:  npm test
 *
 * Exists because of a real failure: every view rendered correctly in JS, but
 * styles.css declared `.view{display:none}` and only revealed `.view.active`.
 * The app emitted `<section class="view">`, so a fully-built 16KB page was
 * inserted into the DOM and then hidden — indistinguishable from "no data".
 *
 * A JS-only test passes that bug. So this checks three layers:
 *   1. DATA    — the built data/ is internally consistent and provenance-complete
 *   2. RENDER  — every view and filter state produces real markup, including the
 *                mention cards that are injected after the view HTML is assigned
 *   3. CSS     — nothing in the cascade hides what render() just produced
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const P = (...p) => path.join(ROOT, ...p);

let fail = 0;
let pass = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  (${detail})` : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`); }
}
function section(s) { console.log(`\n── ${s} ──`); }

/* ------------------------------------------------------------------ 1. DATA */
section("Data integrity");

const D = f => JSON.parse(fs.readFileSync(P("data", f), "utf8"));
/** Collector-side store files (capabilities, health) rather than built data. */
const D2 = f => JSON.parse(fs.readFileSync(P("collectors", "store", f), "utf8"));
let meta, brands, ai, recs;
try {
  meta = D("meta.json"); brands = D("brands.json"); ai = D("ai.json"); recs = D("recommendations.json");
} catch (e) {
  console.error("\n  data/ is not built. Run: node collectors/build.js\n");
  process.exit(1);
}
const payload = { meta, brands, ai, recommendations: recs };
const all = Object.values(brands).flatMap(b => b.mentions);
const ALIASES = JSON.parse(fs.readFileSync(P("config", "brands.json"), "utf8")).brands;

t("all 7 configured products present", Object.keys(brands).length === 7, Object.keys(brands).join(","));
// 8 channels: the 5 socials, blogs, web, and events/sponsorships.
const EXPECTED_CHANNELS = ["linkedin", "x", "youtube", "instagram", "facebook", "blog", "web", "event"];
t("all 8 channels defined",
  EXPECTED_CHANNELS.every(c => meta.channels.some(x => x.id === c)) && meta.channels.length === 8,
  meta.channels.map(c => c.id).join(","));
t("channels are grouped for the summary matrix",
  Array.isArray(meta.channel_groups) && meta.channel_groups.length === 3,
  (meta.channel_groups || []).map(g => g.id).join(","));
// The legacy `video` id must not survive anywhere, or those records vanish from counts.
t("legacy 'video' channel fully migrated to 'youtube'",
  !all.some(m => m.channel === "video") && !meta.channels.some(c => c.id === "video"));

const r = meta.totals.ranges;
t("7/30/90/365 buckets are strictly increasing",
  r["7"].total < r["30"].total && r["30"].total < r["90"].total && r["90"].total < r["365"].total,
  `7=${r["7"].total} 30=${r["30"].total} 90=${r["90"].total} 365=${r["365"].total}`);

t("every mention has an http(s) URL", all.every(m => /^https?:\/\//.test(m.url)));
t("every mention carries auditable evidence naming its own brand",
  all.every(m => m.evidence && m.evidence.length >= 40 &&
    ALIASES[m.brand].aliases.some(a => m.evidence.toLowerCase().includes(a.toLowerCase()))));
t("no aggregator tokens or asset hosts stored as mentions",
  !all.some(m => /news\.google\.com\/rss|googleusercontent|gstatic|google-analytics/.test(m.url)));
t("undated records are excluded from every range bucket",
  all.filter(m => m.days_ago == null).length === meta.integrity.without_date,
  `${meta.integrity.without_date} undated`);

const classified = all.filter(m => m.sentiment);
const norm = s => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
const claudeClassified = classified.filter(m => /claude/i.test(m.sentiment_method || ""));
const providerClassified = classified.filter(m => !/claude/i.test(m.sentiment_method || ""));
t("every CLAUDE-classified sentiment is backed by a quote present in its evidence",
  claudeClassified.every(m => {
    const q = norm(m.sentiment_quote);
    return q.length > 8 && norm(m.evidence).includes(q);
  }),
  `${claudeClassified.length} Claude-classified`);
// Provider labels need attribution rather than a quote — but they must never be
// silently presented as our own judgement.
t("every provider-supplied sentiment names its provider",
  providerClassified.every(m => m.sentiment_method && m.api_source),
  `${providerClassified.length} provider-supplied`);
t("unclassified is tracked as its own state, not folded into neutral",
  all.filter(m => !m.sentiment).length === meta.integrity.sentiment_unclassified);

t("AI visibility covers all 7 products", Object.keys(ai.claude.summary || {}).length === 7);
// Assert the RULE, not an enum of status strings: a share figure may only exist
// when something was actually measured. This is what stops a rate-limited SERP run
// from reporting "appears in 0/10 Google results" — which happened, and would be a
// false claim rather than a missing one.
const WEB_STATES = ["measured", "partially_measured", "measurement_failed", "not_connected"];
t("web/AI-Overview status is a known state", WEB_STATES.includes(ai.web.status), ai.web.status);
t("web/AI-Overview never reports a share unless something was measured",
  (() => {
    const s = ai.web.summary;
    if (!s) return true;                                  // no summary at all — fine
    const anyMeasured = Object.values(s).some(v => (v.prompts_measured ?? 0) > 0);
    if (anyMeasured) return true;                          // real measurement
    // Nothing measured: every share must be null, never 0.
    return Object.values(s).every(v => v.share_pct === null || v.share_pct === undefined);
  })(),
  ai.web.summary ? "summary present" : "summary null");
t("unmeasured LLMs are marked not_connected, never estimated",
  Object.values(ai.other_models || {}).every(m => m.status === "not_connected"));
t("recommendations all cite resolvable evidence",
  (recs.recommendations || []).every(x => Array.isArray(x.evidence) && x.evidence.length > 0));
t("no recommendation title is a prefix of its own detail",
  !(recs.recommendations || []).some(x =>
    x.detail.toLowerCase().startsWith(x.title.toLowerCase().slice(0, 40))));
t("dormant sources are declared with remediation steps",
  (meta.caveats.dormant || []).length === 0 ||
  meta.caveats.dormant.filter(d => d.adapter !== "searxng").every(d => d.how_to_enable),
  (meta.caveats.dormant || []).map(d => d.adapter).join(",") || "none");

/* ---------------------------------------------------------------- 2. RENDER */
section("Render (JS)");

const els = new Map();
function mkEl(id) {
  const el = {
    id, _html: "", style: {},
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null,
    querySelectorAll: () => [], querySelector: () => null,
    appendChild() {}, remove() {}, scrollIntoView() {}, addEventListener() {},
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    set textContent(v) { this._t = String(v); }, get textContent() { return this._t || ""; },
    set onclick(f) { this._c = f; },
  };
  els.set(id, el);
  return el;
}
["tabs", "views", "brandLabel", "dateLabel", "themeBtn", "themeIcon", "foot", "modal",
 "modalCard", "toast", "mentionList", "feedCount", "pager", "auditBox"].forEach(mkEl);

const documentShim = {
  documentElement: { setAttribute() {}, getAttribute: () => "light" },
  querySelector(s) { const m = String(s).match(/^#([\w-]+)$/); return m ? (els.get(m[1]) || mkEl(m[1])) : null; },
  querySelectorAll: () => [], addEventListener() {},
  getElementById(id) { return els.get(id) || mkEl(id); },
  createElement: () => mkEl("tmp"), body: { appendChild() {} },
};
/** Optional payloads. Absent files must degrade, not crash the view. */
const optional = f => { try { return D(f); } catch (e) { return null; } };
const aiHistory = optional("ai-history.json") || { entries: [], count: 0 };
const rankAssets = optional("rank-assets.json") || { recommendations: [] };
const digestLatest = optional("digest-latest.json");
const competitorsData = optional("competitors.json") || { status: "not_scanned", competitors: [] };

/**
 * Route the API shims the way the server does. A view that silently depends on
 * an endpoint shape is exactly what this catches — the previous shim answered
 * every URL with the same payload, so a wrong endpoint looked fine.
 */
function apiShim(u) {
  const s = String(u);
  if (s.includes("/api/data")) return payload;
  if (s.includes("/api/ai/metrics")) {
    const brandsM = meta.brand_order.map(id => ({
      brand_id: id, brand: id, has_data: true, checks_measured: 8, checks_not_measured: 40,
      coverage_pct: 16.7, ai_mention_rate: 37.5, recommendation_rate: 37.5,
      average_position: 1.7, best_position: 1, top3_rate: 37.5, top5_rate: 37.5,
      share_of_ai_voice: 17.6, prompts_probed: 8,
    }));
    return { brands: brandsM, availability: {} };
  }
  if (s.includes("/api/ai/history")) return aiHistory;
  if (s.includes("/api/ai/citations")) return { prompts: [], domain_authority: [], gaps: [] };
  if (s.includes("/api/ai/assets")) return rankAssets;
  if (s.includes("/api/competitors")) return competitorsData;
  if (s.includes("/api/digest")) {
    return { latest: digestLatest, email: { configured: false, missing: ["SMTP_HOST"], requirement: "add SMTP_HOST" }, brightdata: { configured: true, request_api: { available: false, reason: "no zone" } } };
  }
  if (s.includes("/api/webhook")) return { enabled: false, events: [] };
  if (s.includes("/api/me")) return { authenticated: true, email: "test@kovai.co" };
  return D("audit.json");
}

const sandbox = {
  document: documentShim,
  window: {
    addEventListener() {}, scrollTo() {}, innerWidth: 1400,
    matchMedia: () => ({ matches: false }), open() {},
  },
  localStorage: { getItem: () => null, setItem() {} },
  matchMedia: () => ({ matches: false }),
  navigator: { clipboard: { writeText: async () => {} } },
  fetch: async u => ({ ok: true, json: async () => apiShim(u) }),
  Promise,
  console: { log() {}, error() {}, warn() {} },
  setTimeout, clearTimeout, URL, encodeURIComponent, decodeURIComponent,
  Math, JSON, Date, Object, Array, String, Number, Boolean, isNaN, parseInt, parseFloat, Set, Map,
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

let topLevelOk = true;
const SCRIPTS = [...fs.readFileSync(P("public", "index.html"), "utf8")
  .matchAll(/src="\/js\/([\w.-]+)"/g)].map(m => m[1]);
try {
  // Load scripts in the SAME ORDER index.html does, and read that order FROM
  // index.html rather than hardcoding it — app.js delegates to window.D360Premium,
  // window.D360Views and window.D360AI, so a missing or misordered <script> tag
  // is a real breakage this must catch.
  for (const f of SCRIPTS) {
    vm.runInContext(fs.readFileSync(P("public", "js", f), "utf8"), ctx, { filename: f });
  }
} catch (e) {
  topLevelOk = false;
  console.log("  FAIL  a frontend script throws at top level: " + e.message);
  fail++;
}
t(`index.html loads every frontend script (${SCRIPTS.length})`,
  SCRIPTS.includes("app.js") && SCRIPTS.includes("views-ai.js") && SCRIPTS.includes("views-extra.js"),
  SCRIPTS.join(", "));
const WINDOW_GLOBALS = ["D360Premium", "D360Views", "D360AI", "D360Directories"];
t("app.js's window globals are all defined by the loaded scripts",
  topLevelOk && WINDOW_GLOBALS.every(k => sandbox.window[k]),
  WINDOW_GLOBALS.filter(k => !sandbox.window[k]).join(", ") || "all present");

// async: the spend-guard check makes a live balance call, which is the only way
// to prove the guard actually blocks rather than merely existing.
setTimeout(async () => {
  if (topLevelOk) {
    /* Detect TEMPLATE-INTERPOLATION LEAKS, not the bare word.
     *
     * The previous pattern matched "undefined" anywhere in the rendered HTML,
     * which fires on genuine technical content — measured: a Mintlify bug report
     * whose excerpt quotes JavaScript containing `document: undefined`. That is
     * real data faithfully displayed, not a rendering bug, so the old pattern
     * reported a false failure. These patterns only match the shapes a broken
     * template actually produces. */
    const BAD = /="undefined"|="NaN"|>undefined<|>NaN<|\[object Object\]|undefined%|NaNpx|\$\{/;
    const STATES = [
      ["overview", {}], ["mentions", {}], ["ai", {}], ["recommendations", {}], ["sources", {}],
      // The tabs added for competitor discovery and settings must render too.
      ["competitors", {}], ["settings", {}],
      ["overview", { range: 7 }], ["overview", { range: 365 }], ["overview", { range: "all" }],
      ["mentions", { range: 7 }], ["mentions", { includeUndated: true }],
      ["mentions", { channels: ["video"] }], ["mentions", { sentiments: ["negative"] }],
      ["recommendations", { recType: "accelerate_llm" }],
    ];
    let bad = [];
    for (const id of meta.brand_order) {
      for (const [view, extra] of STATES) {
        try {
          vm.runInContext(
            `Object.assign(STATE, ${JSON.stringify({ view, brand: id, page: 1, channels: [], sentiments: [], range: 90, ...extra })}); render();`,
            ctx
          );
          const html = els.get("views")._html;
          if (html.length < 400) bad.push(`${id}/${view} produced only ${html.length} chars`);
          if (html.includes("failed to render")) bad.push(`${id}/${view} hit the error fallback`);
          if (!html.includes('class="view active"')) bad.push(`${id}/${view} missing the .view.active wrapper`);
        } catch (e) {
          bad.push(`${id}/${view} threw: ${e.message}`);
        }
      }
    }
    t(`every view renders for every product (${meta.brand_order.length * STATES.length} combinations)`,
      bad.length === 0, bad.slice(0, 3).join(" | "));

    // Mention cards are injected into #mentionList AFTER the view HTML is set,
    // so they are invisible to a naive "did the view render" assertion.
    let cards = 0, cardProblems = [];
    for (const id of meta.brand_order) {
      vm.runInContext(
        `Object.assign(STATE,{view:"mentions",brand:${JSON.stringify(id)},page:1,channels:[],sentiments:[],range:"all",includeUndated:true}); render();`,
        ctx
      );
      const total = vm.runInContext("filtered().length", ctx);
      const per = vm.runInContext("PER_PAGE", ctx);
      for (let p = 1; p <= Math.max(1, Math.ceil(total / per)); p++) {
        vm.runInContext(`STATE.page=${p}; renderMentionList();`, ctx);
        const h = els.get("mentionList")._html;
        const n = (h.match(/class="card mention[^"]*"/g) || []).length;
        cards += n;
        if (total > 0 && n === 0) cardProblems.push(`${id} page ${p}: no cards`);
        if (BAD.test(h)) cardProblems.push(`${id} page ${p}: literal undefined/NaN in output`);
      }
    }
    if (cardProblems.length) console.log("        " + cardProblems.slice(0, 5).join("\n        "));
    t("every mention card renders across every page", cardProblems.length === 0 && cards === all.length,
      `${cards} cards / ${all.length} records`);

    let modalProblems = [];
    for (const id of meta.brand_order) {
      const first = brands[id].mentions[0];
      if (!first) continue;
      vm.runInContext(`STATE.brand=${JSON.stringify(id)}; showProvenance(${JSON.stringify(first.url)});`, ctx);
      const h = els.get("modalCard")._html;
      if (h.length < 300) modalProblems.push(`${id}: empty`);
      if (BAD.test(h)) modalProblems.push(`${id}: literal undefined/NaN`);
    }
    t("provenance modal renders for every product", modalProblems.length === 0, modalProblems.join(" | "));

    /* ------------------------------------------- AI Visibility panel render */
    // The prompt-search panel must render even with no probe history, because
    // it is the entry point — gating it behind existing data would make a fresh
    // install look broken.
    const A = sandbox.window.D360AI;
    if (A) {
      const ctx2 = { DATA: payload, STATE: { brand: "document360" }, esc: s => String(s) };
      let panelProblems = [];
      try {
        const search = A.promptSearchPanel(ctx2);
        if (!/aiPrompt/.test(search) || !/aiProbeBtn/.test(search)) panelProblems.push("search panel missing its input or button");
        const empty = A.metricsPanel(null, {});
        if (!/no probes yet|not measured/i.test(empty)) panelProblems.push("empty metrics panel does not say it has no data");
        const withData = A.metricsPanel({
          has_data: true, brand: "Document360", prompts_probed: 8, checks_measured: 8,
          checks_not_measured: 40, coverage_pct: 16.7, ai_mention_rate: 37.5,
          recommendation_rate: 37.5, average_position: 1.7, top3_rate: 37.5,
          top5_rate: 37.5, share_of_ai_voice: 17.6,
        }, {});
        for (const label of ["AI mention rate", "Recommendation rate", "Average position", "Top-3 rate", "Top-5 rate", "Share of AI voice"]) {
          if (!withData.includes(label)) panelProblems.push(`metrics panel omits "${label}"`);
        }
        if (BAD.test(search + empty + withData)) panelProblems.push("literal undefined/NaN in a panel");
      } catch (e) {
        panelProblems.push("threw: " + e.message);
      }
      t("AI Visibility panels render, including with no probe history",
        panelProblems.length === 0, panelProblems.slice(0, 3).join(" | "));

      /* A measured absence and an unmeasured surface MUST render differently.
       * They are the two states this whole feature exists to keep apart, and in
       * a dashboard they are one careless template away from looking identical. */
      let stateProblems = [];
      try {
        const probeResult = {
          prompt: "test prompt", brand_id: "document360", probed_at: new Date().toISOString(),
          availability: {},
          providers: {
            google_web: {
              status: "measured", label: "Google / Web", result_count: 20, confidence: 0.95,
              brands: Object.fromEntries(meta.brand_order.map(id => [id, { visible: false, position: null }])),
              citations: [], open_search: "https://www.google.com/search?q=test",
            },
            chatgpt: { status: "not_checked", reason: "No OpenAI API key is configured.", open_search: "https://chatgpt.com/?q=test" },
            claude: { status: "queued", reason: "Queued for the Claude Code session.", open_search: "https://claude.ai/new?q=test" },
            gemini: { status: "not_checked", reason: "No Gemini API key.", open_search: "https://gemini.google.com/app" },
            perplexity: { status: "not_checked", reason: "No Perplexity API key.", open_search: "https://www.perplexity.ai/search?q=test" },
            google_ai_overview: { status: "not_checked", reason: "AI Overview is rendered client-side.", open_search: "https://www.google.com/search?q=test&udm=50" },
          },
        };
        const html2 = A.renderProbe(probeResult, ctx2);
        if (!/Not visible/.test(html2)) stateProblems.push("a measured absence does not render as 'Not visible'");
        if (!/Not measured/.test(html2)) stateProblems.push("an unchecked surface does not render as 'Not measured'");
        // The critical one: an unchecked surface must never be shown as absent.
        const notCheckedCount = (html2.match(/Not measured/g) || []).length;
        if (notCheckedCount !== 5) stateProblems.push(`expected 5 unmeasured surfaces, rendered ${notCheckedCount}`);
        if (!/1 of 6/.test(html2)) stateProblems.push("coverage banner does not state how many surfaces were measured");
        if (BAD.test(html2)) stateProblems.push("literal undefined/NaN in the probe render");
      } catch (e) {
        stateProblems.push("threw: " + e.message);
      }
      t("'not visible' and 'not checked' render as visibly different states",
        stateProblems.length === 0, stateProblems.slice(0, 3).join(" | "));

      /* Every produced asset type must have a renderer. A missing case falls
       * through to a raw JSON dump, which is not a delivered asset. */
      let assetProblems = [];
      for (const r of (rankAssets.recommendations || [])) {
        try {
          const h = A.assetCard(r);
          if (/^\s*<article class="card asset">\s*$/.test(h)) assetProblems.push(`${r.asset_type}: empty card`);
          if (h.includes('class="as-pre">{')) assetProblems.push(`${r.asset_type}: fell through to a raw JSON dump`);
          if (BAD.test(h)) assetProblems.push(`${r.asset_type}: literal undefined/NaN`);
          if (!h.includes("Why this could work")) assetProblems.push(`${r.asset_type}: missing rationale`);
        } catch (e) {
          assetProblems.push(`${r.asset_type} threw: ${e.message}`);
        }
      }
      t(`every produced asset renders with a channel-specific layout (${(rankAssets.recommendations || []).length})`,
        assetProblems.length === 0, assetProblems.slice(0, 3).join(" | "));
    }
  }

  /* --------------------------------------------- 2b. SERVER-SIDE GUARANTEES */
  section("Accuracy gates (server-side)");

  // Threat scoring must be driven by the product's own words, not the keyword.
  const threat = require(P("collectors", "lib", "threat.js"));
  const cases = [
    ["direct", "Acme Docs — the AI knowledge base for customer support", "Pricing. Free trial. Versioning, approval workflow and audit trail.", "direct_competitor"],
    ["disqualified", "Documenso — open source e-signature", "Sign documents online. Free trial. Pricing. Contract management.", "not_a_competitor"],
    ["adjacent", "Clyppy — turn screen recordings into SOPs", "Start free. Pricing. Screen recording to standard operating procedure.", "adjacent_competitor"],
    ["emerging", "DocForge — AI documentation platform", "Join the waitlist. Now in public beta. AI-powered docs.", "emerging_competitor"],
    ["api docs", "Fern: Docs, SDKs and CLIs for your API", "Start with OpenAPI. Interactive API documentation. Pricing.", "direct_competitor"],
  ];
  const wrong = cases.filter(([, id, body, want]) => threat.assess({ identity: id, body_text: body }).classification !== want)
    .map(([label]) => label);
  t(`threat engine classifies all ${cases.length} controlled cases correctly`, wrong.length === 0, wrong.join(", ") || "all correct");

  // Every threat signal must cite the phrase it matched, or the score is opaque.
  const assessed = threat.assess({
    identity: "Acme — AI knowledge base platform",
    body_text: "Pricing. Free trial. Versioning and audit trail. Now in public beta.",
  });
  t("every threat signal cites the phrase it matched",
    assessed.signals.length > 0 && assessed.signals.every(s => (s.evidence || []).length && s.evidence.every(e => e.matched && e.where)),
    `${assessed.signals.length} signal(s)`);

  // Scores must be bounded — an unbounded sum would produce a 130/100 threat.
  const maxed = threat.assess({
    identity: "AI knowledge base documentation platform help center API documentation",
    body_text: "pricing free trial book a demo customers trusted by SOC 2 GDPR versioning approval workflow audit trail SSO SAML localisation multilingual analytics AI assistant AI search RAG LLM MCP server llms.txt just launched raised $10M backed by Y Combinator changelog",
  });
  t("threat score stays within 0-100", maxed.threat_score >= 0 && maxed.threat_score <= 100, `${maxed.threat_score}`);

  /* The asset gates. A validator that accepts everything is worse than none,
   * so each gate is exercised with the exact case it exists to reject. */
  const ra = require(P("collectors", "claude", "rank-assets.js"));
  t("asset validator rejects a stub asset",
    !ra.checkCompleteness("linkedin_post", { body: "too short" }).ok);
  t("asset validator rejects an unknown asset type",
    !ra.checkCompleteness("telepathy", { body: "x".repeat(500) }).ok);
  t("asset validator accepts a complete asset",
    ra.checkCompleteness("linkedin_post", { body: "x".repeat(450) }).ok);
  t("fabrication scanner catches an invented ranking claim",
    ra.scanFabrication("Document360 was rated the number one knowledge base platform").length > 0);
  t("fabrication scanner catches an invented customer statistic",
    ra.scanFabrication("94% of customers report faster onboarding").length > 0);
  t("fabrication scanner leaves ordinary prose alone",
    ra.scanFabrication("Document360 supports versioning, approval workflows and audit trails.").length === 0);

  // Mailer must report exactly what is missing rather than failing silently.
  const mailer = require(P("collectors", "lib", "mailer.js"));
  const ms = mailer.status();
  t("mailer reports its configuration state and names what is missing",
    typeof ms.configured === "boolean" && (ms.configured || (ms.missing.length > 0 && !!ms.requirement)),
    ms.configured ? "configured" : `missing: ${ms.missing.join(", ")}`);
  // Dot-stuffing: a lone "." line would otherwise terminate the SMTP DATA block.
  t("mailer dot-stuffs a message body so SMTP DATA cannot be truncated early",
    mailer.buildMessage({ from: "a@b.c", to: "d@e.f", subject: "s", text: "line1\n.\nline2" }).includes("\r\n..\r\n"));

  // Bright Data capability reporting must be honest about what is unavailable.
  // .env is loaded first so this exercises the configured path rather than the
  // "no key" path — without it the test silently checked a different branch.
  require(P("collectors", "lib", "env.js")).load();
  const bd = require(P("collectors", "lib", "brightdata.js"));
  const rapi = bd.requestApi();
  t("Bright Data reports an unavailable capability with a reason, never as zero",
    typeof rapi.available === "boolean" &&
    (rapi.available ? !!rapi.zone : !!(rapi.reason && rapi.reason.trim())),
    rapi.available ? `zone ${rapi.zone}` : `unavailable: ${String(rapi.reason).slice(0, 60)}…`);
  t("Bright Data dataset discovery modes are recorded per dataset",
    Object.values(bd.DATASETS).every(d => d.id && Array.isArray(d.discover)),
    Object.keys(bd.DATASETS).join(", "));

  // AI history metrics must divide by measured checks, never by attempted.
  const hist = require(P("collectors", "lib", "ai-history.js"));
  const m = hist.metrics("document360");
  if (m.has_data) {
    t("AI metrics divide by measured checks, not attempted",
      m.coverage_pct != null && m.checks_measured > 0 &&
      m.ai_mention_rate <= 100 && m.ai_mention_rate >= 0,
      `${m.checks_measured} measured of ${m.checks_measured + m.checks_not_measured} attempted (coverage ${m.coverage_pct}%)`);
    t("AI metrics never report a rate above 100%",
      [m.ai_mention_rate, m.recommendation_rate, m.top3_rate, m.top5_rate, m.share_of_ai_voice]
        .filter(v => v != null).every(v => v >= 0 && v <= 100));
  } else {
    t("AI metrics return null rather than zero with no data",
      m.ai_mention_rate === null && m.average_position === null, "no probes recorded");
  }

  /* ------------------------------------------------ AI probe (DataForSEO) */
  const probe = require(P("collectors", "lib", "ai-probe.js"));
  const dfsLib = require(P("collectors", "lib", "dataforseo.js"));

  t("all six AI surfaces are declared",
    probe.PROVIDER_ORDER.length === 6 &&
    ["chatgpt", "claude", "gemini", "perplexity", "google_ai_overview", "google_web"]
      .every(k => probe.PROVIDERS[k]),
    probe.PROVIDER_ORDER.join(", "));

  // Deep links must only use parameters the provider genuinely honours.
  const noParam = Object.values(probe.PROVIDERS).filter(p => !p.deeplink_prefills);
  t("a provider with no prompt parameter is not given a fabricated one",
    noParam.length > 0 && noParam.every(p => !/[?&](q|prompt|query)=/.test(p.deeplink("x"))),
    noParam.map(p => p.label).join(", "));
  t("every AI surface records why its deep link works the way it does",
    Object.values(probe.PROVIDERS).every(p => typeof p.deeplink_basis === "string" && p.deeplink_basis.length > 20));

  /* A rank derived from prose must be reproducible and quotable. This is the
   * core claim of the whole feature, so it is tested on a known answer. */
  const ANSWER =
    "For customer-facing help centres, Zendesk is the most common choice. " +
    "Document360 is strong where approval workflows and versioning matter. " +
    "GitBook and Mintlify are better suited to developer documentation.";
  const bt = probe.brandsInText(ANSWER, { citations: [] });
  t("brand order in an LLM answer follows first appearance in the text",
    bt.brands.document360.visible && bt.brands.document360.position === 1 &&
    bt.brands.gitbook.position === 2 && bt.brands.mintlify.position === 3,
    `d360=#${bt.brands.document360.position} gitbook=#${bt.brands.gitbook.position} mintlify=#${bt.brands.mintlify.position}`);
  t("every visible brand carries a quotable excerpt containing its own alias",
    Object.entries(bt.brands).filter(([, v]) => v.visible)
      .every(([id, v]) => v.evidence && v.evidence.toLowerCase().includes(String(v.matched_alias).toLowerCase())));
  t("a brand absent from the answer is a measured absence, not a missing key",
    bt.brands.bloomfire && bt.brands.bloomfire.visible === false && bt.brands.bloomfire.position === null);

  // The ambiguity gate must still apply inside LLM answers.
  const amb = probe.brandsInText("The outcome was decided by a confluence of factors and market timing.");
  t("an ambiguous word in an LLM answer does not become a brand sighting",
    amb.brands.confluence.visible === false, "\"a confluence of factors\" rejected");

  /* Cost control. A billable API with no guard is a bug waiting to happen. */
  const est = dfsLib.estimateProbeCost({});
  t("a full probe's cost is estimable before any call is made",
    est.total > 0 && est.lines.length === 6, `$${est.total.toFixed(4)} across ${est.lines.length} surfaces`);
  t("every DataForSEO provider declares a model and an estimated cost",
    Object.values(dfsLib.PROVIDERS).every(p => p.model && p.cheap_model && p.est_cost > 0));

  /* A redirect wrapper is not a publisher. Gemini returns every citation via
   * vertexaisearch.cloud.google.com, which ranked as the 3rd most authoritative
   * domain in the category until this was handled. */
  const wrapped = dfsLib.resolveCitationDomain(
    "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFc1z0sAAroqpzr", null);
  t("a citation redirect wrapper is not reported as the publisher",
    wrapped.domain === null && wrapped.unresolved === true, JSON.stringify(wrapped));
  t("a real citation domain is preserved unchanged",
    dfsLib.resolveCitationDomain("https://www.gitbook.com/blog/x", null).domain === "gitbook.com");
  t("a publisher named in the citation title is recovered from a wrapper",
    dfsLib.resolveCitationDomain(
      "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AB",
      "Best knowledge base tools - helpjuice.com").domain === "helpjuice.com");

  const authority = require(P("collectors", "lib", "ai-citations.js"))
    .domainAuthority("document360");
  t("domain authority contains no redirect wrappers",
    !authority.some(d => /vertexaisearch|^t\.co$|^news\.google\.com$/.test(d.domain)),
    `${authority.length} domains, top: ${authority.slice(0, 3).map(d => d.domain).join(", ")}`);

  /* ---------------------------------- derived passwords (no provisioning) */
  // Passwords are a pure function of SESSION_SECRET, which is what lets a
  // fresh deploy authenticate with no provisioning step. These assert the
  // properties that makes safe.
  {
    const derived = require(P("collectors", "lib", "derived-auth.js"));
    const prevSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "t".repeat(64);

    const email = "sunil.krishna@kovai.co";
    const pw = derived.derivePassword(email);

    t("a derived password has the expected shape and strength",
      /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(pw),
      pw.length + " chars, 16 symbols from a 32-char alphabet = 80 bits");

    t("derivation is deterministic for the same secret",
      derived.derivePassword(email) === pw);

    t("two accounts never share a password",
      new Set(["a@kovai.co", "b@kovai.co", "c@kovai.co"].map(e => derived.derivePassword(e))).size === 3);

    // Rotating the secret must change every password AND invalidate sessions.
    process.env.SESSION_SECRET = "u".repeat(64);
    t("rotating SESSION_SECRET changes the derived password",
      derived.derivePassword(email) !== pw);

    // The alphabet must divide 256 evenly or the modulo mapping loses entropy.
    t("the password alphabet maps from bytes without bias",
      256 % derived.ALPHABET.length === 0,
      "256 % " + derived.ALPHABET.length + " = " + (256 % derived.ALPHABET.length));

    t("look-alike characters are excluded from the alphabet",
      !["0", "O", "1", "l", "I"].some(c => derived.ALPHABET.includes(c)),
      derived.ALPHABET);

    // With no secret there are no derived passwords, and that must be stated
    // rather than silently producing a weak or empty one.
    delete process.env.SESSION_SECRET;
    t("no secret means derivation reports itself unavailable",
      derived.available() === false && derived.verify(email, pw) === false);

    if (prevSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSecret;
  }

  /* The committed hashes are what let the deployment accept the four
   * distributed passwords, which are random and therefore cannot be derived.
   * They must carry only what auth needs. */
  {
    const ap = P("config", "accounts.json");
    t("account hashes are committed so the deploy can authenticate",
      fs.existsSync(ap), "config/accounts.json present");

    if (fs.existsSync(ap)) {
      const acc = JSON.parse(fs.readFileSync(ap, "utf8"));
      const entries = Object.values(acc.accounts || {});
      const allowedFields = new Set(["email", "salt", "hash"]);
      const extra = [...new Set(entries.flatMap(a => Object.keys(a)))].filter(k => !allowedFields.has(k));
      t("committed accounts expose only email, salt and hash",
        entries.length === 4 && extra.length === 0,
        extra.length ? "also exposes: " + extra.join(", ") : entries.length + " accounts, nothing extra");

      // No plaintext, and no session key: the hash is safe to publish only
      // while SESSION_SECRET is not.
      const vals = JSON.stringify(acc.accounts || {});
      t("no committed account value carries a session key or a password",
        !/SESSION_SECRET/i.test(vals) && !entries.some(a => "password" in a));

      /* A stored hash must be AUTHORITATIVE: a derived password cannot be a
       * second way in. Two live credentials per account would mean there is no
       * single answer to the question what is my password.
       *
       * Tested as behaviour rather than by matching source, because a regex
       * over auth.js breaks on any refactor while telling us nothing about
       * what the code does. */
      const authLib = require(P("collectors", "lib", "auth.js"));
      const derivedLib = require(P("collectors", "lib", "derived-auth.js"));
      const testEmail = Object.keys(acc.accounts || {})[0];
      const prev = process.env.SESSION_SECRET;
      process.env.SESSION_SECRET = "z".repeat(64);
      if (testEmail && derivedLib.available()) {
        const dpw = derivedLib.derivePassword(testEmail);
        // A unique IP per attempt, so the rate limiter does not mask the result.
        const r = authLib.login(testEmail, dpw, "10.99." + Math.floor(Math.random() * 250) + ".1");
        t("a derived password is refused when a stored hash exists",
          r.ok === false,
          r.ok ? "ACCEPTED - two live credentials per account" : "exactly one password per account");
      }
      if (prev === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = prev;    }
  }
  /* ------------------------------------------------- scraping fallback chain */
  {
    const sc = require(P("collectors", "lib", "scrape.js"));

    // Hosts measured to refuse a direct fetch must skip it, or every scrape of
    // them wastes a round trip before falling through.
    t("the WAF-protected directories are known to the chain",
      ["g2.com", "capterra.com", "trustradius.com", "softwareadvice.com", "gartner.com"]
        .every(h => sc.KNOWN_WALLED.test(h)) && !sc.KNOWN_WALLED.test("example.com"));

    /* A 200 carrying a challenge page is the dangerous case: it looks like
     * success and parses to nothing, which is how a bot wall silently becomes
     * "this company has no products". Measured on G2: the default proxy mode
     * returned exactly that in 2,562 bytes. */
    t("a small 200 containing a bot challenge counts as blocked",
      sc.looksBlocked({ ok: true, bytes: 2562, body: "Just a moment... enable JavaScript and cookies" }) === true);
    t("a large real page is not treated as blocked merely for mentioning captcha",
      sc.looksBlocked({ ok: true, bytes: 948680, body: "x".repeat(100) + " captcha " + "y".repeat(100) }) === false);
    t("an empty 200 is not accepted as content",
      sc.looksBlocked({ ok: true, bytes: 120, body: "tiny" }) === true);
    t("a failed response is blocked",
      sc.looksBlocked({ ok: false, status: 403 }) === true);

    // ScrapeBadger must be inert-with-a-reason rather than silently empty.
    const badger = sc.badgerStatus();
    t("ScrapeBadger states why it is unavailable rather than returning nothing",
      badger.ok || /SCRAPEBADGER_SCRAPER|scraper-name|not configured/i.test(badger.reason || ""),
      badger.ok ? "configured: " + badger.scraper : "inert, reason given");

    const routes = sc.routeStatus();
    t("at least one scraping route is available",
      Object.values(routes).some(r => r.available),
      Object.entries(routes).filter(([, r]) => r.available).map(([k]) => k).join(" -> "));
  }

  /* --------------------------------------- environment variable hygiene */
  // A duplicate key is a value you believe you set and did not: the later
  // assignment silently wins. Both files are checked because .env.example is
  // what a teammate copies.
  // Regexes here are built from char codes rather than written as literals:
  // a scripted edit mangled the escape sequences in this exact block twice,
  // splitting a regex across two lines and breaking the whole file.
  const SPLIT_LINES = new RegExp(String.fromCharCode(13) + "?" + String.fromCharCode(10));
  const NL_PORT = String.fromCharCode(10) + "PORT=";

  for (const envFile of [".env", ".env.example"]) {
    const abs = P(envFile);
    if (!fs.existsSync(abs)) continue;
    const keys = fs.readFileSync(abs, "utf8").split(SPLIT_LINES)
      .map(l => (l.match(/^([A-Z0-9_]+)=/) || [])[1]).filter(Boolean);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    t(`${envFile} declares every key exactly once`,
      dupes.length === 0,
      dupes.length ? [...new Set(dupes)].join(", ") : `${keys.length} unique`);
  }

  // PORT is reserved on Vercel, so it must be documented as local-only —
  // otherwise a reader pastes it in and hits a rejected variable.
  {
    const ex = fs.readFileSync(P(".env.example"), "utf8");
    const at = ex.indexOf(NL_PORT);
    const portBlock = at === -1 ? "" : ex.slice(Math.max(0, at - 700), at + 10);
    t("PORT is documented as local-only and flagged as reserved on Vercel",
      /RESERVED/i.test(portBlock) && /LOCAL/i.test(portBlock));
  }

  /* ------------------------------- review-directory audit precision gates */
  const dirLib = require(P("collectors", "lib", "directories.js"));

  t("all 7 directories and 6 categories are configured",
    dirLib.DIRECTORIES.length === 7 && dirLib.CATEGORIES.length === 6,
    `${dirLib.DIRECTORIES.map(d => d.id).join(", ")} × ${dirLib.CATEGORIES.map(c => c.id).join(", ")}`);

  /* A product page must be told apart from a compare/alternatives/category page.
   * Counting the latter would invent listings that do not exist. */
  const URL_CASES = [
    ["g2", "https://www.g2.com/products/stonly/reviews", true],
    ["g2", "https://www.g2.com/products/docuwriter-ai/competitors/alternatives", false],
    ["g2", "https://www.g2.com/categories/knowledge-base", false],
    ["capterra", "https://www.capterra.com/p/229790/Waybook/reviews/", true],
    ["capterra", "https://www.capterra.com/knowledge-management-software/", false],
    ["trustradius", "https://www.trustradius.com/products/comm100/reviews", true],
    ["trustradius", "https://www.trustradius.com/compare-products/airmason-vs-knova", false],
    ["gartner", "https://www.gartner.com/reviews/product/guru-1380120009", true],
    ["gartner", "https://www.gartner.com/reviews/market/knowledge-management-software", false],
    ["softwareadvice", "https://www.softwareadvice.com/crm/kms-lighthouse-profile/", true],
    ["softwareadvice", "https://www.softwareadvice.com/crm/knowledge-base-comparison/", false],
  ];
  const urlWrong = URL_CASES.filter(([dir, url, want]) =>
    dirLib.matchProductPage(url, dirLib.byId[dir]).ok !== want).map(([, url]) => url);
  t(`product-page recognition is correct on all ${URL_CASES.length} URL shapes`,
    urlWrong.length === 0, urlWrong.slice(0, 2).join(", ") || "all correct");

  /* A name built only from category vocabulary is a category page. */
  const GENERIC_CASES = [
    ["Customer Portal", true], ["Knowledge Management", true],
    ["Contact Center Knowledge Base Software", true], ["Free Document Maker", true],
    ["Stonly", false], ["Shelf", false], ["KMS Lighthouse", false],
    ["Heroic Knowledge Base", false], ["livepro Knowledge Management", false],
  ];
  const genWrong = GENERIC_CASES.filter(([n, want]) => dirLib.isGenericName(n) !== want).map(([n]) => n);
  t(`generic-name gate is correct on all ${GENERIC_CASES.length} names`,
    genWrong.length === 0, genWrong.join(", ") || "all correct");

  /* Names must normalise to the same string across directories, or one product
   * becomes several. Measured: "DocuWriter.ai" and "DocuWriter.ai Software"
   * were counted as two products, and "DHTMLX - 2026" would never merge with
   * "DHTMLX" from another directory. */
  const NAME_CASES = [
    ["softwareadvice", "DocuWriter.ai Software Reviews, Ratings & Features 2026 - Software Advice", "docuwriter-ai", "DocuWriter.ai"],
    ["getapp", "DHTMLX - 2026 Pricing, Features, Reviews & Alternatives | GetApp", "dhtmlx", "DHTMLX"],
    ["g2", "Stonly Reviews 2026: Details, Pricing, & Features - G2", "stonly", "Stonly"],
    ["capterra", "Waybook Reviews 2026. Verified Reviews, Pros & Cons - Capterra", "Waybook", "Waybook"],
    ["g2", "Page 10 | n8n Reviews 2026: Details, Pricing, & Features - G2", "n8n", "n8n"],
  ];
  const nameWrong = NAME_CASES.filter(([dir, title, slug, want]) =>
    dirLib.extractName(title, slug, dirLib.byId[dir]).name !== want)
    .map(([, , , want]) => want);
  t(`product names normalise consistently across directories (${NAME_CASES.length} cases)`,
    nameWrong.length === 0, nameWrong.join(", ") || "all correct");

  /* A vendor's product line carries the vendor name as its first token.
   * Measured bug: the incumbent "zoho" is 4 characters, so a >=5-character
   * prefix rule let "Zoho Desk" through as a new product. */
  const ex2 = dirLib.buildExclusions();
  t("a product line of a tracked product or incumbent is excluded by its first token",
    !!dirLib.exclusionReason("Atlassian Confluence", "atlassian-confluence", ex2) &&
    !!dirLib.exclusionReason("Notion AI", "notion-ai", ex2) &&
    !dirLib.exclusionReason("Stonly", "stonly", ex2));

  /* Category confirmation must reject topic-adjacent products.
   * Every case below was ADMITTED by a looser first pass and is a real
   * measured false positive. */
  const CAT_CASES = [
    ["customer_self_service", "a straightforward self-service portal for employees, cuts down paperwork", false, "Paylocity (payroll)"],
    ["customer_self_service", "GenAI-powered self-service BI and analytics platform", false, "Zoho Analytics (BI)"],
    ["customer_self_service", "self-service portal that makes invoice review and payment easy", false, "Invoiced"],
    ["customer_self_service", "lowers barriers to self-service and governance for your Kafka implementation", false, "Axual (Kafka)"],
    ["customer_self_service", "self-service knowledge base for customer support teams", true, "a real self-service KB"],
    ["ai_doc_generator", "extracts data from forms and documents using OCR", false, "Azure AI Document Intelligence"],
    ["ai_doc_generator", "AI powered document processing platform that automates data extraction", false, "Lido"],
    ["ai_doc_generator", "AI documentation generator that writes code documentation", true, "DocuWriter.ai"],
    ["api_documentation", "support for mutual TLS (mTLS), traffic policies, and observability", false, "Kong Konnect (gateway)"],
    ["api_documentation", "cryptocurrency price data API for developers", false, "CoinGecko API"],
    ["api_documentation", "Interactive API documentation and developer hub", true, "ReadMe"],
  ];
  const catWrong = CAT_CASES.filter(([cat, snippet, want]) =>
    dirLib.confirmCategory(cat, { title: "X Reviews 2026", snippet, url: "https://www.g2.com/products/x/reviews" }).confirmed !== want
  ).map(([, , , label]) => label);
  t(`category confirmation is correct on all ${CAT_CASES.length} measured cases`,
    catWrong.length === 0, catWrong.join("; ") || "all correct");

  t("the search term that surfaced a product is never used to confirm its category",
    // The query text is not a parameter of confirmCategory at all.
    dirLib.confirmCategory.length === 2 &&
    !dirLib.confirmCategory("knowledge_base", { title: "Paycom Reviews", snippet: "payroll and HR", url: "https://www.trustradius.com/products/paycom/reviews" }).confirmed);

  // Directory findings must keep their evidence URL and their confidence basis.
  const dirData = (() => { try { return D("directory-listings.json"); } catch (e) { return null; } })();
  if (dirData && dirData.status === "audited") {
    const noEvidence = (dirData.products || []).filter(p => !(p.listings || []).length || !p.listings[0].url);
    t("every directory listing links to the page it was found on",
      noEvidence.length === 0, noEvidence.map(p => p.product).join(", ") || "all linked");
    const noBasis = (dirData.products || []).filter(p => !(p.confidence_basis || []).length);
    t("every directory listing states what its confidence rests on",
      noBasis.length === 0, noBasis.map(p => p.product).join(", ") || "all explained");
    // A product with no resolved website must say so, never show threat 0.
    const falseZero = (dirData.products || []).filter(p => !p.website && p.threat_score === 0);
    t("a product with no resolved website is 'not assessed', never threat 0",
      falseZero.length === 0, falseZero.map(p => p.product).join(", ") || "none");
  }

  /* A site's own description is sometimes an unrendered template. Measured:
   * liveagent.com serves `${e.title} ${t?` ${s}. `:""} ${e.title} . ${n}.` as
   * its meta description — real content, but it tells a reader nothing and
   * rendering it looks like this dashboard's template broke. */
  const { isUsableDescription } = require(P("collectors", "lib", "verify.js"));
  const DESC_CASES = [
    ['${e.title} ${t?` ${s}. `:""} ${e.title} . ${n}.', false],
    ["{{ product.description }}", false],
    ["%PRODUCT_NAME% is the best", false],
    ["You need to enable JavaScript to run this app.", false],
    ["We use cookies to improve your experience on our site.", false],
    ["Stonly helps you build interactive guides and a self-service knowledge base.", true],
  ];
  const descWrong = DESC_CASES.filter(([s, want]) => isUsableDescription(s).ok !== want).length;
  t(`unrendered templates and boilerplate are rejected as descriptions (${DESC_CASES.length} cases)`,
    descWrong === 0, descWrong ? `${descWrong} wrong` : "all correct");

  // And nothing already stored still carries one.
  const storedDescs = [
    ...((dirData && dirData.products) || []),
    ...((competitorsData && competitorsData.competitors) || []),
  ].filter(p => p.description && !isUsableDescription(p.description).ok);
  t("no stored description is an unrendered template",
    storedDescs.length === 0,
    storedDescs.map(p => p.product || p.name).join(", ") || "none");

  /* ------------------------------------- Windsor.ai first-party layer */
  const windsor = require(P("collectors", "lib", "windsor.js"));

  // Source classification must recognise every shape GA4 actually recorded,
  // including the malformed ones ("chatgpt.com)*", "chatgpt.com=").
  const AI_CASES = [
    ["chatgpt.com / ai-assistant", "chatgpt"],
    ["chatgpt.com / referral", "chatgpt"],
    ["chatgpt.com)* / (not set)", "chatgpt"],
    ["openai / (not set)", "chatgpt"],
    ["claude.ai / ai-assistant", "claude"],
    ["gemini.google.com / referral", "gemini"],
    ["perplexity.ai / ai-assistant", "perplexity"],
    ["copilot.com / ai-assistant", "copilot"],
    ["google / organic", null],
    ["(direct) / (none)", null],
    ["bing / organic", null],
  ];
  const misread = AI_CASES.filter(([s, want]) => {
    const got = windsor.classifyAiSource(s);
    return (got ? got.id : null) !== want;
  }).map(([s]) => s);
  t(`AI referral source classification is correct on all ${AI_CASES.length} recorded shapes`,
    misread.length === 0, misread.join("; ") || "all correct");
  t("ordinary search traffic is not counted as an AI referral",
    !windsor.classifyAiSource("google / organic") && !windsor.classifyAiSource("bing / organic"));

  /* A rejected Windsor query must surface as an error, never as zero rows.
   * Measured: `total_users` with `session_source_medium` returns HTTP 400, and
   * an earlier version reported that as "no AI referrals found". */
  const badQuery = await windsor.query("googleanalytics4", {
    fields: ["session_source_medium", "total_users"], datePreset: "last_7d", useCache: false,
  });
  t("a rejected Windsor query reports an error rather than an empty result set",
    badQuery.ok === false && !!badQuery.error,
    String(badQuery.error || "").slice(0, 70) + "…");

  // First-party data covers our own property only; a competitor figure would be
  // fabricated, so the scope limit must be carried in the payload itself.
  const wCaps = (() => { try { return D2("windsor-capabilities.json"); } catch (e) { return null; } })();
  if (wCaps) {
    t("the first-party scope limit is stated in the stored capability record",
      typeof wCaps.scope_limit === "string" && /competitor/i.test(wCaps.scope_limit));
  }

  const guard = await dfsLib.checkBudget(999, { spentThisProbe: 0 });
  t("the spend guard refuses a call that would exceed the budget",
    guard.allowed === false && /cap|balance|reserve/i.test(guard.reason || ""),
    String(guard.reason || "").slice(0, 60) + "…");

  // A budget stop must be reported as not_checked, never as absence.
  t("a budget stop is classified as 'not checked', not as a visibility result",
    (() => {
      const src = fs.readFileSync(P("collectors", "lib", "ai-probe.js"), "utf8");
      // Both LLM and AI-Overview paths must map a skip to not_checked.
      return (src.match(/status:\s*r\.skipped\s*\?\s*"not_checked"\s*:\s*"failed"/g) || []).length >= 2;
    })());

  /* Competitor records must keep launch date and discovery date separate: a
   * product found today is not a product launched today. */
  const comps = (competitorsData.competitors || []);
  if (comps.length) {
    const conflated = comps.filter(c => c.launch_date && c.first_seen &&
      c.launch_date === String(c.first_seen).slice(0, 10) && !c.launch_date_basis);
    t("launch date is never silently filled in from the discovery date",
      conflated.length === 0, conflated.map(c => c.name).join(", ") || "kept distinct");
    const scoredButUnexplained = comps.filter(c => c.threat_score != null && !c.classification_basis);
    t("every scored entrant carries the basis for its classification",
      scoredButUnexplained.length === 0, scoredButUnexplained.map(c => c.name).join(", ") || "all explained");
    const noEvidence = comps.filter(c => !c.evidence_url && !c.website);
    t("every entrant links to the page it was judged from",
      noEvidence.length === 0, noEvidence.map(c => c.name).join(", ") || "all linked");
  }

  /* Every `npm run X` the code tells a user to run must actually exist.
   * Measured: the AI Visibility panel instructed "npm run ai:prompts", which
   * was never a script — a remediation step that does nothing is worse than no
   * step, because the reader concludes the feature is broken. */
  const pkgScripts = new Set(Object.keys(JSON.parse(fs.readFileSync(P("package.json"), "utf8")).scripts || {}));
  const sourceFiles = [
    ...fs.readdirSync(P("collectors", "lib")).map(f => P("collectors", "lib", f)),
    ...fs.readdirSync(P("collectors", "claude")).map(f => P("collectors", "claude", f)),
    ...fs.readdirSync(P("public", "js")).map(f => P("public", "js", f)),
    P("server.js"),
  ].filter(f => f.endsWith(".js"));
  const badScripts = new Set();
  for (const f of sourceFiles) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/npm run ([a-z][\w:-]*)/g)) {
      if (!pkgScripts.has(m[1])) badScripts.add(`${m[1]} (${path.basename(f)})`);
    }
  }
  t("every 'npm run X' the code instructs a user to run exists in package.json",
    badScripts.size === 0, [...badScripts].join(", ") || "all resolve");

  // No credential may appear in anything the browser receives.
  // DATAFORSEO_B64 is base64("login:password") — a credential, not an id, so it
  // is checked like any other secret. Its decoded form is checked too, since
  // base64 is encoding rather than protection.
  const KEYS = [
    "OCTOLENS_API_KEY", "NEWSAPI_KEY", "BRIGHTDATA_API_KEY",
    "DATAFORSEO_B64", "DATAFORSEO_PASSWORD", "WINDSOR_API_KEY", "SMTP_PASS",
  ];
  const envText = (() => { try { return fs.readFileSync(P(".env"), "utf8"); } catch (e) { return ""; } })();
  const secrets = [];
  for (const k of KEYS) {
    const v = (envText.match(new RegExp("^" + k + "=(.+)$", "m")) || [])[1];
    if (!v || v.length <= 8) continue;
    secrets.push(v);
    // A base64 credential must not leak in either form.
    if (k === "DATAFORSEO_B64") {
      try {
        const decoded = Buffer.from(v, "base64").toString("utf8");
        const pass = decoded.split(":")[1];
        if (pass && pass.length > 8) secrets.push(pass);
      } catch (e) { /* not decodable; the encoded form is still checked */ }
    }
  }
  const clientText = ["index.html", "login.html"].map(f => fs.readFileSync(P("public", f), "utf8")).join("\n") +
    fs.readdirSync(P("public", "js")).map(f => fs.readFileSync(P("public", "js", f), "utf8")).join("\n") +
    JSON.stringify(payload) + JSON.stringify(competitorsData) + JSON.stringify(rankAssets) + JSON.stringify(aiHistory);
  const leaked = secrets.filter(s => clientText.includes(s));
  t(`no API key appears in frontend code or any API payload (${secrets.length} key(s) checked)`,
    leaked.length === 0, leaked.length ? "LEAKED" : "none leaked");

  /* -------------------------------------------------------------- 3. CSS */
  section("CSS visibility (the layer a JS test cannot see)");

  const html = fs.readFileSync(P("public", "index.html"), "utf8");
  const sheets = [...html.matchAll(/href="\/css\/([\w.]+)"/g)].map(m => m[1]);
  const css = sheets.map(f => ({ file: f, text: fs.readFileSync(P("public", "css", f), "utf8") }));
  const allCss = css.map(c => c.text).join("\n");

  /* Every stylesheet must be linked by SOME page, not necessarily the dashboard.
   * login.css belongs to login.html only — asserting index.html links it was
   * wrong once authentication introduced a second page. An orphan stylesheet
   * (linked by nothing) is still a real defect and is what this now catches. */
  const pages = fs.readdirSync(P("public")).filter(f => f.endsWith(".html"));
  const linkedAnywhere = new Set();
  for (const pg of pages) {
    const src = fs.readFileSync(P("public", pg), "utf8");
    for (const m of src.matchAll(/href="\/css\/([\w.-]+)"/g)) linkedAnywhere.add(m[1]);
  }
  const cssFiles = fs.readdirSync(P("public", "css")).filter(f => f.endsWith(".css"));
  const orphanCss = cssFiles.filter(f => !linkedAnywhere.has(f));
  t("no stylesheet is orphaned (every file linked by some page)",
    orphanCss.length === 0,
    orphanCss.length ? "orphaned: " + orphanCss.join(", ") : `${cssFiles.length} files across ${pages.length} pages`);
  t("dashboard loads its stylesheets in order", sheets.length >= 4, sheets.join(" → "));

  // Same rule for scripts: an orphaned script is dead weight and a load-order
  // bug waiting to happen.
  const linkedJs = new Set();
  for (const pg of pages) {
    const src = fs.readFileSync(P("public", pg), "utf8");
    for (const m of src.matchAll(/src="\/js\/([\w.-]+)"/g)) linkedJs.add(m[1]);
  }
  const jsFiles = fs.readdirSync(P("public", "js")).filter(f => f.endsWith(".js"));
  const orphanJs = jsFiles.filter(f => !linkedJs.has(f));
  t("no script is orphaned", orphanJs.length === 0,
    orphanJs.length ? "orphaned: " + orphanJs.join(", ") : `${jsFiles.length} files`);

  // The actual regression: is the element render() produces visible?
  const hidesView = css.some(c => /\.view\s*\{[^}]*display\s*:\s*none/.test(c.text));
  const lastShowsView = (() => {
    // Later sheets win; find the last declaration for a bare `.view`.
    let visible = null;
    for (const c of css) {
      for (const m of c.text.matchAll(/\.view\s*\{([^}]*)\}/g)) {
        const d = /display\s*:\s*(\w+)/.exec(m[1]);
        if (d) visible = d[1] !== "none";
      }
    }
    return visible;
  })();
  t("the .view element render() emits is not hidden by the cascade",
    lastShowsView === true || hidesView === false,
    hidesView ? "a sheet sets display:none, a later one must override it" : "never hidden");

  t("app.js emits the .active class the base sheet expects",
    /class="view active"/.test(fs.readFileSync(P("public", "js", "app.js"), "utf8")));

  // Any class the app renders but no sheet defines will silently lose styling.
  const used = new Set();
  const appSrc = fs.readFileSync(P("public", "js", "app.js"), "utf8") + html;
  for (const m of appSrc.matchAll(/class=["'`]([^"'`$]*)/g)) {
    m[1].split(/\s+/).filter(Boolean).forEach(c => used.add(c));
  }
  const defined = new Set();
  for (const m of allCss.matchAll(/\.([a-zA-Z][\w-]*)/g)) defined.add(m[1]);
  // Template-interpolated prefixes (e.g. `pri-${priority}`) end in a dash.
  const missing = [...used].filter(c => !defined.has(c) && !c.endsWith("-"));
  t("every static class the app renders is defined in CSS", missing.length === 0, missing.join(", ") || "none");

  console.log(`\n${fail ? `${fail} FAILED, ` : ""}${pass} passed\n`);
  process.exit(fail ? 1 : 0);
}, 400);
