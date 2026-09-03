/**
 * DataForSEO client — the API that finally makes AI Visibility measurable.
 *
 * WHAT THIS UNLOCKS (all probed live on 2026-09-01, see npm run api:health)
 * ------------------------------------------------------------------------
 *   ChatGPT     POST /v3/ai_optimization/chat_gpt/llm_responses/live
 *   Claude      POST /v3/ai_optimization/claude/llm_responses/live
 *   Gemini      POST /v3/ai_optimization/gemini/llm_responses/live
 *   Perplexity  POST /v3/ai_optimization/perplexity/llm_responses/live
 *   Google AI Overview  POST /v3/serp/google/ai_mode/live/advanced
 *   Google organic      POST /v3/serp/google/organic/live/advanced
 *
 * Each returns the model's ACTUAL answer text plus its real citation URLs, so
 * "is Document360 visible in ChatGPT" stops being unanswerable and becomes a
 * measurement with a quotable answer behind it.
 *
 * THE TWO CONSTRAINTS THAT SHAPE THIS FILE
 * ----------------------------------------
 * 1. IT COSTS REAL MONEY, AND THE BALANCE IS SMALL.
 *    Measured per call: Perplexity $0.006, Gemini $0.036, Claude $0.024-0.054,
 *    ChatGPT $0.077 with web search (but $0.0007 for gpt-4o-mini without),
 *    Google AI Overview $0.004, Google organic $0.002. A six-surface probe is
 *    therefore ~$0.15, and the account held $1.00.
 *
 *    So: every call is budget-checked BEFORE it is made, every result is cached
 *    so re-opening a prompt is free, and the balance is re-read and reported.
 *    An exhausted budget produces an explicit "not checked — budget" rather than
 *    a silent failure that would look like "not visible".
 *
 * 2. REASONING MODELS REJECT `max_output_tokens`.
 *    Measured: gpt-5-nano, gpt-5.4-mini and o4-mini all return
 *    `40501 Invalid Field: 'max_output_tokens'`. The models endpoint exposes a
 *    `reasoning` flag, so the field is omitted for those rather than guessed at.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { fetchUrl, fetchJson } = require("./fetch");

const BASE = "https://api.dataforseo.com/v3";
const STORE = path.join(__dirname, "..", "store");
const CACHE_FILE = path.join(STORE, "dataforseo-cache.json");
const SPEND_FILE = path.join(STORE, "dataforseo-spend.json");

/** Cached answers stay valid for a week — AI answers drift, but not hourly. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Default models. Chosen for cost per useful answer, measured rather than
 * assumed: Perplexity is the best value by an order of magnitude, and
 * claude-haiku returned only 186 characters with web search so sonnet is used
 * despite costing more — a cheap answer that says nothing measures nothing.
 */
const PROVIDERS = {
  chatgpt: {
    id: "chatgpt", path: "chat_gpt", label: "ChatGPT", vendor: "OpenAI",
    model: "gpt-4o", cheap_model: "gpt-4o-mini",
    est_cost: 0.077, est_cost_cheap: 0.02,
  },
  claude: {
    id: "claude", path: "claude", label: "Claude", vendor: "Anthropic",
    model: "claude-sonnet-4-5", cheap_model: "claude-haiku-4-5",
    est_cost: 0.054, est_cost_cheap: 0.024,
  },
  gemini: {
    id: "gemini", path: "gemini", label: "Gemini", vendor: "Google",
    model: "gemini-2.5-flash", cheap_model: "gemini-2.5-flash-lite",
    est_cost: 0.037, est_cost_cheap: 0.036,
  },
  perplexity: {
    id: "perplexity", path: "perplexity", label: "Perplexity", vendor: "Perplexity AI",
    model: "sonar", cheap_model: "sonar",
    est_cost: 0.0065, est_cost_cheap: 0.0065,
  },
};

const SERP_COSTS = { ai_overview: 0.004, organic: 0.002 };

/* --------------------------------------------------------------------- auth */

function credentials() {
  // A pre-encoded value is accepted because that is how the credential was
  // supplied; login+password is encoded here when that is what is configured.
  const b64 = process.env.DATAFORSEO_B64 || "";
  if (b64) return b64;
  const login = process.env.DATAFORSEO_LOGIN || "";
  const pass = process.env.DATAFORSEO_PASSWORD || "";
  if (login && pass) return Buffer.from(`${login}:${pass}`).toString("base64");
  return "";
}

function configured() {
  return !!credentials();
}

function authHeaders(extra = {}) {
  return { Authorization: "Basic " + credentials(), ...extra };
}

function credentialStatus() {
  if (!configured()) {
    return {
      ok: false,
      reason: "DataForSEO is not configured — DATAFORSEO_B64 (or DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD) is not set in .env.",
      how_to_enable: "Add DATAFORSEO_B64 to .env, then run: npm run api:health",
    };
  }
  return { ok: true, reason: null };
}

/* -------------------------------------------------------------------- cache */

function readJsonSafe(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return fallback; }
}
function writeJsonSafe(f, obj) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(obj, null, 2));
  } catch (e) { /* cache is an optimisation, never a hard dependency */ }
}

function cacheKey(parts) {
  return crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 20);
}

function cacheGet(key, { maxAgeMs = CACHE_TTL_MS } = {}) {
  const c = readJsonSafe(CACHE_FILE, { entries: {} });
  const hit = c.entries[key];
  if (!hit) return null;
  if (Date.now() - new Date(hit.cached_at).getTime() > maxAgeMs) return null;
  return hit;
}

function cachePut(key, value) {
  const c = readJsonSafe(CACHE_FILE, { entries: {} });
  c.entries[key] = { ...value, cached_at: new Date().toISOString() };
  // Bound the cache so it cannot grow without limit.
  const keys = Object.keys(c.entries);
  if (keys.length > 800) {
    keys.map(k => [k, c.entries[k].cached_at]).sort((a, b) => String(a[1]).localeCompare(String(b[1])))
      .slice(0, keys.length - 800).forEach(([k]) => delete c.entries[k]);
  }
  writeJsonSafe(CACHE_FILE, c);
}

/* -------------------------------------------------------------------- spend */

/**
 * Recorded spend, so the dashboard can show what a measurement actually cost
 * and a runaway loop is visible after the fact rather than only on the invoice.
 */
function readSpend() {
  return readJsonSafe(SPEND_FILE, { total: 0, calls: 0, by_day: {}, recent: [] });
}

function recordSpend(endpoint, cost, meta = {}) {
  const s = readSpend();
  const day = new Date().toISOString().slice(0, 10);
  s.total = Math.round((s.total + (cost || 0)) * 1e6) / 1e6;
  s.calls++;
  s.by_day[day] = Math.round(((s.by_day[day] || 0) + (cost || 0)) * 1e6) / 1e6;
  s.recent = [{ at: new Date().toISOString(), endpoint, cost: cost || 0, ...meta }, ...(s.recent || [])].slice(0, 200);
  writeJsonSafe(SPEND_FILE, s);
  return s;
}

/** Live account balance. Free to call (cost 0). */
async function balance() {
  if (!configured()) return { ok: false, reason: credentialStatus().reason };
  const r = await fetchJson(`${BASE}/appendix/user_data`, { headers: authHeaders(), retries: 1, timeout: 30000 });
  const t = r.json && r.json.tasks && r.json.tasks[0];
  if (!t || t.status_code !== 20000) {
    return { ok: false, status: r.status, reason: (t && t.status_message) || `HTTP ${r.status}` };
  }
  const money = t.result[0].money || {};
  return {
    ok: true,
    balance: money.balance,
    total: money.total,
    login: t.result[0].login,
    checked_at: new Date().toISOString(),
  };
}

/**
 * A spend guard. Returns { allowed, reason } BEFORE any billable call.
 *
 * `DATAFORSEO_MIN_BALANCE` keeps a floor in reserve so a probe cannot empty the
 * account; `DATAFORSEO_MAX_PROBE_COST` caps one probe. Both are advisory
 * defaults that the operator can raise.
 */
async function checkBudget(estimatedCost, { spentThisProbe = 0 } = {}) {
  const minBalance = Number(process.env.DATAFORSEO_MIN_BALANCE || 0.05);
  const maxProbe = Number(process.env.DATAFORSEO_MAX_PROBE_COST || 0.25);

  if (spentThisProbe + estimatedCost > maxProbe) {
    return {
      allowed: false,
      reason:
        `Skipped to stay inside the per-probe cost cap: this call is ~$${estimatedCost.toFixed(4)} and ` +
        `$${spentThisProbe.toFixed(4)} has already been spent on this probe (cap $${maxProbe.toFixed(2)}). ` +
        `Raise DATAFORSEO_MAX_PROBE_COST in .env to query more surfaces per probe.`,
    };
  }

  const b = await balance();
  if (!b.ok) {
    return { allowed: false, reason: `Could not read the DataForSEO balance: ${b.reason}` };
  }
  if (b.balance - estimatedCost < minBalance) {
    return {
      allowed: false,
      balance: b.balance,
      reason:
        `Skipped: the DataForSEO balance is $${b.balance.toFixed(4)} and this call costs ~$${estimatedCost.toFixed(4)}, ` +
        `which would drop below the $${minBalance.toFixed(2)} reserve. Top up the DataForSEO account to resume ` +
        `measuring this surface. This is a budget stop, NOT a measurement of absence.`,
    };
  }
  return { allowed: true, balance: b.balance };
}

/* ------------------------------------------------------------ LLM responses */

/** Which models a provider offers, and which support web search. */
async function models(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return { ok: false, reason: `unknown provider ${providerId}` };
  const r = await fetchJson(`${BASE}/ai_optimization/${p.path}/llm_responses/models`, {
    headers: authHeaders(), retries: 1, timeout: 30000,
  });
  const t = r.json && r.json.tasks && r.json.tasks[0];
  if (!t || t.status_code !== 20000) return { ok: false, reason: (t && t.status_message) || `HTTP ${r.status}` };
  return { ok: true, models: t.result || [] };
}

/** Cached reasoning-model lookup: those reject `max_output_tokens`. */
const reasoningCache = new Map();
async function isReasoningModel(providerId, modelName) {
  const key = providerId + "|" + modelName;
  if (reasoningCache.has(key)) return reasoningCache.get(key);
  const m = await models(providerId);
  if (!m.ok) { reasoningCache.set(key, false); return false; }
  for (const x of m.models) reasoningCache.set(providerId + "|" + x.model_name, !!x.reasoning);
  return reasoningCache.get(key) || false;
}

/**
 * Redirect wrappers that hide the real publisher.
 *
 * Gemini returns every citation as `vertexaisearch.cloud.google.com/grounding-api-redirect/…`,
 * which made that host look like the 3rd most authoritative domain in the
 * category. It is not a publisher at all — it is Google's redirector. Where the
 * real domain cannot be recovered, the citation is kept (the URL still works)
 * but its domain is marked unresolved so it cannot pollute domain authority.
 */
const REDIRECT_HOSTS = /^(vertexaisearch\.cloud\.google\.com|www\.google\.com|news\.google\.com|r\.jina\.ai|t\.co)$/i;

function resolveCitationDomain(url, title) {
  let host = null;
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return { domain: null, unresolved: true }; }

  if (!REDIRECT_HOSTS.test(host)) return { domain: host, unresolved: false };

  // A wrapped URL sometimes carries the destination in a query parameter, and
  // a citation title is often "Title - realdomain.com".
  try {
    const u = new URL(url);
    for (const k of ["url", "u", "q", "target", "dest"]) {
      const v = u.searchParams.get(k);
      if (v && /^https?:\/\//.test(v)) {
        return { domain: new URL(v).hostname.replace(/^www\./, ""), unresolved: false, recovered_from: k };
      }
    }
  } catch (e) { /* fall through */ }

  /* Citation titles are often "Article title - realdomain.com".
   *
   * A TLD allowlist rather than a generic `\.[a-z]{2,}` pattern: the generic
   * form matched ordinary prose like "vs.the" as a hostname, inventing a
   * publisher out of a sentence. A wrong domain here is worse than none. */
  const TLD = "com|io|ai|co|net|org|dev|app|so|inc|cloud|tech|software|help|docs|site|xyz|me|us|uk|de|fr|in|ca|au";
  const m = String(title || "").match(
    new RegExp(`\\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLD}))\\b`, "i"));
  if (m) return { domain: m[1].replace(/^www\./, "").toLowerCase(), unresolved: false, recovered_from: "title" };

  return { domain: null, unresolved: true, redirect_host: host };
}

/**
 * Normalise one LLM response into { text, citations }.
 * The answer arrives as sections with annotations; both shapes are handled
 * because the providers differ in which they populate.
 */
function normaliseLlm(item) {
  const sections = (item && item.sections) || [];
  const text = sections.map(s => s.text || "").filter(Boolean).join("\n\n").trim();

  const seen = new Set();
  const citations = [];
  for (const s of sections) {
    for (const a of (s.annotations || [])) {
      const url = a.url || (a.link && a.link.url) || null;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = a.title || a.text || null;
      const d = resolveCitationDomain(url, title);
      citations.push({
        url, title,
        domain: d.domain,
        // Carried through so the UI and the citation analysis can say "publisher
        // not recoverable" instead of naming a redirector as a source.
        domain_unresolved: !!d.unresolved,
        domain_recovered_from: d.recovered_from || null,
        redirect_host: d.redirect_host || null,
      });
    }
  }
  return { text, citations };
}

/**
 * Ask one LLM a prompt and return its real answer.
 *
 * Returns `{ ok:false, skipped:"budget" }` when the guard blocks it, which the
 * caller must render as "not checked", never as absence.
 */
async function llmResponse(providerId, prompt, {
  model = null,
  webSearch = true,
  maxTokens = 900,
  cheap = false,
  useCache = true,
  spentThisProbe = 0,
  log = () => {},
} = {}) {
  const p = PROVIDERS[providerId];
  if (!p) return { ok: false, error: `unknown provider ${providerId}` };
  const cred = credentialStatus();
  if (!cred.ok) return { ok: false, error: cred.reason, skipped: "not_configured" };

  const modelName = model || (cheap ? p.cheap_model : p.model);
  const key = cacheKey(["llm", providerId, modelName, prompt, webSearch, maxTokens]);

  if (useCache) {
    const hit = cacheGet(key);
    if (hit) {
      log(`      ${p.label}: cache hit (${hit.text_length} chars, ${hit.citations.length} citations) — $0.00`);
      return { ...hit, ok: true, from_cache: true, cost: 0 };
    }
  }

  const est = cheap ? p.est_cost_cheap : p.est_cost;
  const budget = await checkBudget(est, { spentThisProbe });
  if (!budget.allowed) {
    log(`      ${p.label}: SKIPPED — ${budget.reason.slice(0, 90)}`);
    return { ok: false, skipped: "budget", error: budget.reason, estimated_cost: est };
  }

  const payload = { user_prompt: prompt, model_name: modelName, web_search: webSearch };
  // Reasoning models reject this field outright (40501), so it is omitted.
  if (!(await isReasoningModel(providerId, modelName))) payload.max_output_tokens = maxTokens;

  const body = JSON.stringify([payload]);
  const r = await fetchUrl(`${BASE}/ai_optimization/${p.path}/llm_responses/live`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }),
    body,
    retries: 1,
    timeout: 240000,
    maxBytes: 16 * 1024 * 1024,
  });

  let j = null;
  try { j = JSON.parse(r.body); } catch (e) { /* handled below */ }
  const t = j && j.tasks && j.tasks[0];
  const cost = (j && j.cost) || 0;
  if (cost) recordSpend(`${p.path}/llm_responses/live`, cost, { model: modelName, prompt: prompt.slice(0, 80) });

  if (!t || t.status_code !== 20000) {
    const msg = (t && t.status_message) || `HTTP ${r.status}`;
    log(`      ${p.label}: API error ${t ? t.status_code : r.status} — ${msg}`);
    return { ok: false, error: `${p.label} API error ${t ? t.status_code : r.status}: ${msg}`, cost, model: modelName };
  }

  const item = t.result && t.result[0] && t.result[0].items && t.result[0].items[0];
  const { text, citations } = normaliseLlm(item);

  if (!text) {
    return {
      ok: false,
      error: `${p.label} returned an empty answer (model ${modelName}). Not a measurement of absence.`,
      cost, model: modelName,
    };
  }

  const out = {
    ok: true,
    provider: providerId,
    model: modelName,
    web_search: webSearch,
    text,
    text_length: text.length,
    citations,
    cost,
    answered_at: new Date().toISOString(),
    from_cache: false,
  };
  cachePut(key, { ...out, ok: undefined });
  log(`      ${p.label}: ${text.length} chars, ${citations.length} citations — $${cost.toFixed(4)}`);
  return out;
}

/* ------------------------------------------------------------ Google SERP */

/**
 * Google AI Overview via the AI-Mode endpoint.
 *
 * IMPORTANT: the plain organic endpoint returns the AI Overview as an EMPTY
 * placeholder with `asynchronous_ai_overview: true` — measured, and it would
 * have rendered as "AI Overview present but empty", which is worse than not
 * asking. The ai_mode endpoint returns the real markdown and references.
 */
async function googleAiOverview(keyword, {
  locationCode = 2840, languageCode = "en", useCache = true, spentThisProbe = 0, log = () => {},
} = {}) {
  const cred = credentialStatus();
  if (!cred.ok) return { ok: false, error: cred.reason, skipped: "not_configured" };

  const key = cacheKey(["aio", keyword, locationCode, languageCode]);
  if (useCache) {
    const hit = cacheGet(key);
    if (hit) { log(`      Google AI Overview: cache hit — $0.00`); return { ...hit, ok: true, from_cache: true, cost: 0 }; }
  }

  const budget = await checkBudget(SERP_COSTS.ai_overview, { spentThisProbe });
  if (!budget.allowed) {
    log(`      Google AI Overview: SKIPPED — budget`);
    return { ok: false, skipped: "budget", error: budget.reason, estimated_cost: SERP_COSTS.ai_overview };
  }

  const body = JSON.stringify([{ keyword, location_code: locationCode, language_code: languageCode, device: "desktop" }]);
  const r = await fetchUrl(`${BASE}/serp/google/ai_mode/live/advanced`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }),
    body, retries: 1, timeout: 180000, maxBytes: 16 * 1024 * 1024,
  });

  let j = null;
  try { j = JSON.parse(r.body); } catch (e) { /* handled below */ }
  const t = j && j.tasks && j.tasks[0];
  const cost = (j && j.cost) || 0;
  if (cost) recordSpend("serp/google/ai_mode/live/advanced", cost, { keyword });

  if (!t || t.status_code !== 20000) {
    const msg = (t && t.status_message) || `HTTP ${r.status}`;
    return { ok: false, error: `Google AI Mode API error ${t ? t.status_code : r.status}: ${msg}`, cost };
  }

  const res = t.result && t.result[0];
  const ao = ((res && res.items) || []).find(i => i.type === "ai_overview");
  if (!ao) {
    // A genuine measured absence: Google returned no AI Overview for this query.
    const out = { ok: true, present: false, text: "", citations: [], cost, measured_at: new Date().toISOString(),
      note: "Google returned no AI Overview for this query — a measured absence, not a failed measurement." };
    cachePut(key, { ...out, ok: undefined });
    log(`      Google AI Overview: none shown for this query — $${cost.toFixed(4)}`);
    return out;
  }

  const text = ao.markdown ||
    ((ao.items || []).map(x => x.text || "").filter(Boolean).join("\n\n"));

  const seen = new Set();
  const citations = [];
  for (const src of [...(ao.references || []), ...((ao.items || []).flatMap(x => x.references || []))]) {
    const url = src.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    citations.push({ url, title: src.title || null, domain: src.domain || (() => {
      try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return null; }
    })() });
  }

  const out = {
    ok: true, present: true,
    text: String(text || "").trim(),
    text_length: String(text || "").length,
    citations, cost,
    measured_at: new Date().toISOString(),
    from_cache: false,
  };
  cachePut(key, { ...out, ok: undefined });
  log(`      Google AI Overview: ${out.text_length} chars, ${citations.length} references — $${cost.toFixed(4)}`);
  return out;
}

/** Real Google organic ranking. Cheaper and more authoritative than SearXNG. */
async function googleOrganic(keyword, {
  locationCode = 2840, languageCode = "en", useCache = true, spentThisProbe = 0, log = () => {},
} = {}) {
  const cred = credentialStatus();
  if (!cred.ok) return { ok: false, error: cred.reason, skipped: "not_configured" };

  const key = cacheKey(["organic", keyword, locationCode, languageCode]);
  if (useCache) {
    const hit = cacheGet(key);
    if (hit) { log(`      Google organic: cache hit (${hit.results.length}) — $0.00`); return { ...hit, ok: true, from_cache: true, cost: 0 }; }
  }

  const budget = await checkBudget(SERP_COSTS.organic, { spentThisProbe });
  if (!budget.allowed) return { ok: false, skipped: "budget", error: budget.reason, estimated_cost: SERP_COSTS.organic };

  const body = JSON.stringify([{ keyword, location_code: locationCode, language_code: languageCode, device: "desktop", depth: 20 }]);
  const r = await fetchUrl(`${BASE}/serp/google/organic/live/advanced`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }),
    body, retries: 1, timeout: 180000, maxBytes: 16 * 1024 * 1024,
  });

  let j = null;
  try { j = JSON.parse(r.body); } catch (e) { /* handled below */ }
  const t = j && j.tasks && j.tasks[0];
  const cost = (j && j.cost) || 0;
  if (cost) recordSpend("serp/google/organic/live/advanced", cost, { keyword });

  if (!t || t.status_code !== 20000) {
    const msg = (t && t.status_message) || `HTTP ${r.status}`;
    return { ok: false, error: `Google organic API error ${t ? t.status_code : r.status}: ${msg}`, cost };
  }

  const items = ((t.result && t.result[0] && t.result[0].items) || []).filter(i => i.type === "organic");
  const results = items.map(i => ({
    rank: i.rank_group,
    url: i.url,
    title: i.title || null,
    content: i.description || i.snippet || "",
    domain: i.domain ? String(i.domain).replace(/^www\./, "") : null,
    engine: "google",
  }));

  const out = { ok: true, results, cost, measured_at: new Date().toISOString(), from_cache: false };
  cachePut(key, { ...out, ok: undefined });
  log(`      Google organic: ${results.length} ranked results — $${cost.toFixed(4)}`);
  return out;
}

/** What one full probe would cost right now, before spending anything. */
function estimateProbeCost({ surfaces = null, cheap = false } = {}) {
  const want = surfaces || ["google_ai_overview", "google_organic", "chatgpt", "claude", "gemini", "perplexity"];
  let total = 0;
  const lines = [];
  for (const s of want) {
    let c = 0;
    if (s === "google_ai_overview") c = SERP_COSTS.ai_overview;
    else if (s === "google_organic") c = SERP_COSTS.organic;
    else if (PROVIDERS[s]) c = cheap ? PROVIDERS[s].est_cost_cheap : PROVIDERS[s].est_cost;
    total += c;
    lines.push({ surface: s, estimated_cost: c });
  }
  return { total: Math.round(total * 1e4) / 1e4, lines };
}

module.exports = {
  BASE, PROVIDERS, SERP_COSTS,
  configured, credentialStatus, credentials,
  balance, readSpend, checkBudget,
  models, llmResponse, googleAiOverview, googleOrganic,
  estimateProbeCost, normaliseLlm, resolveCitationDomain,
  CACHE_FILE, SPEND_FILE,
};
