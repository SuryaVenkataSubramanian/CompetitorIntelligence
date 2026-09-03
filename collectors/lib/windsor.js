/**
 * Windsor.ai client — first-party analytics as an additional evidence layer.
 *
 * WHAT THIS ACCOUNT ACTUALLY HAS (probed 2026-09-01, `npm run windsor:probe`)
 * -------------------------------------------------------------------------
 *   googleanalytics4   WORKS — 12,821 rows / 90d, property "Docs Document360"
 *   youtube            WORKS — Document360's own channel, per-video metrics
 *   linkedin           WORKS — LinkedIn ADS (campaigns, ad forms), 19 rows
 *   everything else    no account linked for this Windsor user
 *
 * WHY GA4 MATTERS MORE THAN IT LOOKS
 * ----------------------------------
 * GA4 is the only source in this project that measures the OUTCOME of AI
 * visibility rather than its appearance. DataForSEO answers "does ChatGPT name
 * Document360"; GA4 answers "did anyone actually arrive from ChatGPT". Measured
 * over 90 days on the docs property: 3,468 sessions from AI assistants —
 * ChatGPT 2,541, Claude 443, Gemini 302, Perplexity 116.
 *
 * That is first-party, non-inferred, and free to query, which also makes it the
 * natural fallback when the DataForSEO balance runs out.
 *
 * A LIMIT WORTH STATING PLAINLY
 * -----------------------------
 * GA4 sees only OUR OWN site. It can say how much AI traffic Document360
 * receives; it can say nothing about competitors. So it enriches the
 * Document360 view and is explicitly unavailable for the other six products —
 * reported as such, never as a zero.
 *
 * FIELD COMBINATIONS ARE VALIDATED SERVER-SIDE AND FAIL WITH HTTP 400.
 * Measured: `total_users` alongside `session_source_medium` returns 400. An
 * earlier version treated any non-2xx as an empty result set, which turned a
 * rejected query into "no AI referrals found" — a false zero. Errors are now
 * surfaced verbatim.
 */
const fs = require("fs");
const path = require("path");
const { fetchJson } = require("./fetch");

const BASE = "https://connectors.windsor.ai";
const STORE = path.join(__dirname, "..", "store");
const CACHE_FILE = path.join(STORE, "windsor-cache.json");

/** GA4 is free to query but not instant; an hour is fresh enough for a dashboard. */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Source/medium patterns that identify an AI assistant referral.
 *
 * Built from what GA4 actually recorded rather than from a guess: the property
 * uses a dedicated `ai-assistant` medium, but the same hosts also arrive under
 * `referral`, `organic`, `(not set)` and `(none)`, plus a few malformed variants
 * ("chatgpt.com)*", "chatgpt.com="). Matching on the HOST catches all of them.
 */
const AI_SOURCES = [
  { id: "chatgpt", label: "ChatGPT", re: /chatgpt|openai/i },
  { id: "claude", label: "Claude", re: /claude|anthropic/i },
  { id: "gemini", label: "Gemini", re: /gemini|bard\.google/i },
  { id: "perplexity", label: "Perplexity", re: /perplexity/i },
  { id: "copilot", label: "Copilot", re: /copilot|bing chat/i },
  { id: "other_ai", label: "Other AI", re: /you\.com|phind|poe\.com|deepseek|grok|mistral|meta\.ai/i },
];

function apiKey() {
  return process.env.WINDSOR_API_KEY || "";
}

function configured() {
  return !!apiKey();
}

function credentialStatus() {
  if (!configured()) {
    return {
      ok: false,
      reason: "Windsor.ai is not configured — WINDSOR_API_KEY is not set in .env.",
      how_to_enable: "Add WINDSOR_API_KEY to .env, then run: npm run windsor:probe",
    };
  }
  return { ok: true, reason: null };
}

/* -------------------------------------------------------------------- cache */

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch (e) { return { entries: {} }; }
}
function writeCache(c) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2));
  } catch (e) { /* cache is an optimisation */ }
}

/* -------------------------------------------------------------------- query */

/**
 * Query one connector.
 *
 * Returns { ok, rows } or { ok:false, error } — never an empty `rows` standing
 * in for a rejected request, because that is how a 400 becomes a false zero.
 */
async function query(connector, {
  fields,
  datePreset = "last_90d",
  dateFrom = null,
  dateTo = null,
  useCache = true,
  log = () => {},
} = {}) {
  const cred = credentialStatus();
  if (!cred.ok) return { ok: false, error: cred.reason, skipped: "not_configured" };
  if (!fields || !fields.length) return { ok: false, error: "no fields requested" };

  const fieldList = Array.isArray(fields) ? fields.join(",") : String(fields);
  const key = [connector, fieldList, datePreset, dateFrom, dateTo].join("|");

  if (useCache) {
    const c = readCache();
    const hit = c.entries[key];
    if (hit && Date.now() - new Date(hit.cached_at).getTime() < CACHE_TTL_MS) {
      log(`      windsor/${connector}: cache hit (${hit.rows.length} rows)`);
      return { ok: true, rows: hit.rows, from_cache: true, fetched_at: hit.cached_at };
    }
  }

  const params = new URLSearchParams({ api_key: apiKey(), fields: fieldList });
  if (dateFrom && dateTo) {
    params.set("date_from", dateFrom);
    params.set("date_to", dateTo);
  } else {
    params.set("date_preset", datePreset);
  }

  const r = await fetchJson(`${BASE}/${connector}?${params}`, {
    retries: 1,
    timeout: 150000,
    maxBytes: 128 * 1024 * 1024,
  });

  // An explicit API error must never look like an empty result.
  if (!r.ok || (r.json && r.json.error)) {
    const msg = (r.json && r.json.error) || r.error || `HTTP ${r.status}`;
    log(`      windsor/${connector}: ERROR ${msg}`);
    return {
      ok: false,
      status: r.status,
      error: `Windsor ${connector} rejected the query: ${msg}`,
      // Field combinations are validated server-side, and that is the usual cause.
      hint: /field/i.test(String(msg))
        ? "Not every field combination is valid together — `total_users` with `session_source_medium` returns 400, for example."
        : null,
    };
  }
  if (!r.json || !Array.isArray(r.json.data)) {
    return { ok: false, status: r.status, error: "Windsor returned an unexpected shape (no data array)" };
  }

  const rows = r.json.data;
  const c = readCache();
  c.entries[key] = { rows, cached_at: new Date().toISOString() };
  // Bound the cache; GA4 responses are large.
  const keys = Object.keys(c.entries);
  if (keys.length > 40) {
    keys.map(k => [k, c.entries[k].cached_at])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
      .slice(0, keys.length - 40)
      .forEach(([k]) => delete c.entries[k]);
  }
  writeCache(c);

  log(`      windsor/${connector}: ${rows.length} rows`);
  return { ok: true, rows, from_cache: false, fetched_at: new Date().toISOString() };
}

/** Which connectors have data on this account, and which are simply not linked. */
async function connectors({ log = () => {} } = {}) {
  const candidates = [
    "googleanalytics4", "youtube", "linkedin", "facebook", "instagram",
    "google_ads", "bing", "linkedin_organic", "facebook_organic", "instagram_public",
  ];
  const out = [];
  for (const c of candidates) {
    const r = await query(c, { fields: ["date"], datePreset: "last_7d", log: () => {} });
    out.push({
      connector: c,
      available: r.ok,
      rows: r.ok ? r.rows.length : 0,
      // "not linked" and "broken" are different facts.
      reason: r.ok ? null : String(r.error || "").replace(/^Windsor \w+ rejected the query: /, ""),
    });
    log(`    ${c.padEnd(20)} ${r.ok ? `${r.rows.length} row(s)` : "unavailable"}`);
  }
  return out;
}

/* --------------------------------------------------- AI referral aggregation */

function classifyAiSource(sourceMedium) {
  const s = String(sourceMedium || "");
  for (const a of AI_SOURCES) if (a.re.test(s)) return a;
  return null;
}

/**
 * Sessions arriving from AI assistants, by surface.
 *
 * This is the outcome half of AI visibility, and it is first-party: no model is
 * asked anything, no page is scraped. GA4 recorded these visits.
 */
async function aiReferrals({ datePreset = "last_90d", useCache = true, log = () => {} } = {}) {
  const r = await query("googleanalytics4", {
    // This exact combination is verified to work. `total_users` breaks it.
    fields: ["date", "session_source_medium", "landing_page", "sessions"],
    datePreset, useCache, log,
  });
  if (!r.ok) return { ok: false, error: r.error, hint: r.hint || null, skipped: r.skipped || null };

  const bySurface = {};
  const byLandingPage = {};
  const byDate = {};
  const rawSources = {};
  let totalSessions = 0;
  let aiSessions = 0;

  for (const row of r.rows) {
    const sessions = Number(row.sessions || 0);
    totalSessions += sessions;

    const ai = classifyAiSource(row.session_source_medium);
    if (!ai) continue;
    aiSessions += sessions;

    const s = (bySurface[ai.id] = bySurface[ai.id] || {
      id: ai.id, label: ai.label, sessions: 0, landing_pages: {}, source_mediums: {},
    });
    s.sessions += sessions;
    s.source_mediums[row.session_source_medium] = (s.source_mediums[row.session_source_medium] || 0) + sessions;

    const page = row.landing_page || "(not set)";
    s.landing_pages[page] = (s.landing_pages[page] || 0) + sessions;
    byLandingPage[page] = (byLandingPage[page] || 0) + sessions;

    if (row.date) byDate[row.date] = (byDate[row.date] || 0) + sessions;
    rawSources[row.session_source_medium] = (rawSources[row.session_source_medium] || 0) + sessions;
  }

  // Rank landing pages inside each surface — which page an assistant sends
  // people to is the actionable part.
  const surfaces = Object.values(bySurface)
    .map(s => ({
      ...s,
      share_of_ai_pct: aiSessions ? Math.round((s.sessions / aiSessions) * 1000) / 10 : null,
      top_landing_pages: Object.entries(s.landing_pages)
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([page, sessions]) => ({ page, sessions })),
      source_mediums: Object.entries(s.source_mediums)
        .sort((a, b) => b[1] - a[1])
        .map(([source_medium, sessions]) => ({ source_medium, sessions })),
      landing_pages: undefined,
    }))
    .sort((a, b) => b.sessions - a.sessions);

  return {
    ok: true,
    method:
      "Google Analytics 4 via Windsor.ai — first-party session data for the Document360 property. " +
      "These are recorded visits, not model answers: no page was scraped and no model was asked.",
    property: null, // filled by caller when account_name is queried
    date_preset: datePreset,
    fetched_at: r.fetched_at,
    from_cache: !!r.from_cache,

    total_sessions: totalSessions,
    ai_sessions: aiSessions,
    ai_share_pct: totalSessions ? Math.round((aiSessions / totalSessions) * 10000) / 100 : null,

    surfaces,
    top_landing_pages: Object.entries(byLandingPage)
      .sort((a, b) => b[1] - a[1]).slice(0, 25)
      .map(([page, sessions]) => ({ page, sessions })),
    by_date: Object.entries(byDate).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([date, sessions]) => ({ date, sessions })),
    // Kept so the classification is auditable rather than a black box.
    raw_ai_source_mediums: Object.entries(rawSources)
      .sort((a, b) => b[1] - a[1]).map(([source_medium, sessions]) => ({ source_medium, sessions })),

    // The limit, stated in the payload so the UI cannot omit it.
    scope_limit:
      "First-party only: this measures traffic to Document360's own property. It says nothing about " +
      "competitors, so it is available for Document360 and unavailable — not zero — for the other six products.",
  };
}

/* ----------------------------------------------------- YouTube own-channel */

/**
 * Per-video metrics for Document360's own YouTube channel.
 * Used to enrich existing YouTube mention records with real engagement rather
 * than leaving them at "no engagement data".
 */
async function youtubeVideos({ datePreset = "last_365d", useCache = true, log = () => {} } = {}) {
  const r = await query("youtube", {
    fields: ["video", "video_title", "videourl", "video_view_count", "video_like_count", "video_comment_count", "channel_title"],
    datePreset, useCache, log,
  });
  if (!r.ok) return { ok: false, error: r.error, skipped: r.skipped || null };

  const videos = r.rows
    .filter(v => v.video || v.videourl)
    .map(v => ({
      video_id: v.video || null,
      title: v.video_title || null,
      url: v.videourl || (v.video ? `https://www.youtube.com/watch?v=${v.video}` : null),
      views: v.video_view_count != null ? Number(v.video_view_count) : null,
      likes: v.video_like_count != null ? Number(v.video_like_count) : null,
      comments: v.video_comment_count != null ? Number(v.video_comment_count) : null,
      channel: v.channel_title || null,
    }));

  return { ok: true, videos, fetched_at: r.fetched_at, from_cache: !!r.from_cache };
}

module.exports = {
  BASE, AI_SOURCES,
  configured, credentialStatus,
  query, connectors, aiReferrals, youtubeVideos, classifyAiSource,
  CACHE_FILE,
};
