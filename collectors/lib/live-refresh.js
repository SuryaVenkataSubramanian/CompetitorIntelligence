/**
 * The Refresh button's engine: an in-process live sweep.
 *
 * WHY IN-PROCESS AND NOT A SPAWNED COLLECTOR
 * ------------------------------------------
 * Every other refresh in this project spawns a child process. That is correct
 * for a sweep that takes ten minutes, and wrong for a button a person is
 * watching, for two reasons:
 *
 *   1. A serverless host has no child processes at all, so the spawning
 *      endpoints answer 501 there. The hosted dashboard — the one the team
 *      actually opens — could never refresh anything.
 *   2. A spawned collector's results only reach the browser after a full
 *      rebuild of data/. In-process, the records can be returned directly, so
 *      the user sees this minute's mentions even where nothing can be written
 *      to disk.
 *
 * So this runs the sweep inline, returns the records, and persists them only
 * where persistence is possible. On a read-only host the response is still
 * real, live data — it just does not survive the request, and it says so.
 *
 * WHAT IT SWEEPS
 * --------------
 *   lib/freshsources  eleven keyless sources (Google News, HN, DuckDuckGo,
 *                     YouTube, GitHub, Stack Exchange, status pages,
 *                     alternatives aggregators, Mastodon, GDELT, Reddit)
 *   twitterapi.io     X keyword search, when credits remain
 *   SerpAPI           site:linkedin.com/posts — ONE query, and only when the
 *                     LinkedIn channel was asked for. SerpAPI is capped at 250
 *                     searches a month, so it is never used for bulk.
 *
 * "TO THE EXACT MINUTE" is the requirement, and it is met by the window being
 * computed from Date.now() at call time rather than from a stored cursor, and
 * by every source being queried live rather than read from cache.
 */
const path = require("path");
const fs = require("fs");
const { verifyCandidates } = require("./pipeline");
const { upsertMentions, logRun } = require("./store");
const freshsources = require("./freshsources");
const deployment = require("./deployment");
const { brandOrder, brand } = require("./brands");

const ROOT = path.join(__dirname, "..", "..");

/* --------------------------------------------------------------- X / Twitter */

/**
 * X via twitterapi.io. Credits went NEGATIVE (-518) mid-project, so the credit
 * check comes first: without it an exhausted plan produces one 402 per brand,
 * which reads as several per-brand failures instead of one account-level stop.
 */
async function sweepX({ brands, sinceDays, log }) {
  const out = { candidates: [], gaps: [], ran: false, reason: null };
  let adapter;
  try { adapter = require("../adapters/x-twitterapi"); } catch (e) {
    out.reason = "x adapter unavailable: " + e.message;
    return out;
  }
  const cred = adapter.credentialStatus ? adapter.credentialStatus() : { ok: true };
  if (!cred.ok) { out.reason = cred.reason; return out; }

  try {
    const r = await adapter.collect({ sinceDays, brands, log });
    out.candidates = r.candidates || [];
    out.gaps = r.gaps || [];
    out.ran = true;
  } catch (e) {
    out.reason = "x sweep threw: " + String(e.message || e);
  }
  return out;
}

/* ----------------------------------------------------------------- LinkedIn */

/**
 * LinkedIn, via the one provider left that can reach it.
 *
 * LinkedIn has no usable public API here, Bright Data's dataset suspended with
 * the account, and DuckDuckGo refuses site: queries outright. SerpAPI is real
 * Google and does honour site:, which makes it the only working route — but the
 * plan allows 250 searches a MONTH, so this spends exactly one query per brand
 * and only when the caller actually asked for LinkedIn.
 */
async function sweepLinkedIn({ brands, log }) {
  const out = { candidates: [], gaps: [], ran: false, reason: null };
  const serpapi = require("./serpapi");
  if (!serpapi.configured()) { out.reason = serpapi.credentialStatus().reason; return out; }

  const probe = await serpapi.probe();
  if (!probe.ok) { out.reason = probe.reason; return out; }

  for (const id of brands) {
    const b = brand(id);
    const q = 'site:linkedin.com/posts "' + b.aliases[0] + '"';
    const r = await serpapi.search(q, { log, num: 20 });
    if (!r.ok) { out.gaps.push({ brand_id: id, reason: "SerpAPI: " + String(r.error).slice(0, 90) }); continue; }

    for (const hit of r.results || []) {
      if (!hit.url || !/linkedin\.com\/posts/i.test(hit.url)) continue;
      const text = [hit.title, hit.snippet].filter(Boolean).join(". ");
      if (!freshsources.firstAliasIn(text, id)) continue;

      out.candidates.push({
        brand_id: id,
        channel: "linkedin",
        url: hit.url,
        title: hit.title || null,
        // Google's snippet carries no reliable post date, and inventing one
        // from the crawl date would put a wrong day on a real post.
        published_at: null,
        date_method: null,
        source_text: text,
        source_verified: true,
        source_adapter: "linkedin_serpapi",
        discovered_via: "serpapi: " + q,
        author: null,
        extra: { serp_position: hit.position || null, matched_alias: freshsources.firstAliasIn(text, id) },
      });
    }
    out.ran = true;
    log("      linkedin: " + b.name + " — " + out.candidates.filter(c => c.brand_id === id).length + " post(s) via SerpAPI");
  }
  return out;
}

/* ------------------------------------------------------------------- sweep */

/**
 * Run a live refresh.
 *
 * @param {string[]} brands    brand ids, or null for all seven
 * @param {string[]} channels  channel ids the caller cares about, or null
 * @param {number}   days      window, computed from now at call time
 */
async function refresh({
  brands = null,
  channels = null,
  days = 7,
  log = () => {},
} = {}) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const order = brandOrder();
  const ids = brands && brands.length ? brands.filter(b => order.includes(b)) : order;
  const want = channels && channels.length ? channels : null;

  const perSource = [];
  const gaps = [];
  let candidates = [];

  /* 1. The keyless layer. Always runs: it is the only part that cannot be
   *    switched off by a billing balance. */
  log("  keyless sources");
  const fresh = await freshsources.sweep({ brands: ids, sinceDays: days, log });
  candidates = candidates.concat(fresh.candidates);
  gaps.push(...fresh.gaps);
  perSource.push(...fresh.per_source);

  /* 2. X, when the plan has credits. */
  if (!want || want.includes("x")) {
    log("  > X (twitterapi.io)");
    const x = await sweepX({ brands: ids, sinceDays: days, log });
    candidates = candidates.concat(x.candidates);
    gaps.push(...x.gaps.map(g => Object.assign({ source: "x_twitterapi" }, g)));
    perSource.push({
      id: "x_twitterapi", label: "X (twitterapi.io)", tier: "metered",
      candidates: x.candidates.length, gaps: x.gaps.length, ok: x.ran,
      error: x.ran ? null : x.reason,
    });
  }

  /* 3. LinkedIn, one metered query per brand, only if asked for. */
  if (want && want.includes("linkedin")) {
    log("  > LinkedIn (SerpAPI site: query)");
    const li = await sweepLinkedIn({ brands: ids, log });
    candidates = candidates.concat(li.candidates);
    gaps.push(...li.gaps.map(g => Object.assign({ source: "linkedin_serpapi" }, g)));
    perSource.push({
      id: "linkedin_serpapi", label: "LinkedIn (SerpAPI)", tier: "metered",
      candidates: li.candidates.length, gaps: li.gaps.length, ok: li.ran,
      error: li.ran ? null : li.reason,
    });
  }

  const found = candidates.length;

  /* 4. THE SAME VERIFICATION PIPELINE AS EVERY OTHER PATH.
   *    A live refresh must not be a way to get unverified records into the
   *    store — the button would then be a hole in the evidence rule. */
  log("  verifying " + found + " candidate(s)");
  const verified = await verifyCandidates(candidates, { concurrency: 12, log });
  const records = verified.records || [];

  /* 5. Persist where possible. On a read-only host this fails and the records
   *    are still returned — live data that does not survive the request is
   *    worth more than a 501. */
  let persisted = false;
  let added = 0;
  let storeTotal = null;
  let persistError = null;
  if (deployment.capabilities().persistent_writes && records.length) {
    try {
      const up = upsertMentions(records);
      added = up.added;
      storeTotal = up.total;
      persisted = true;
      logRun({
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        kind: "live-refresh",
        window_days: days,
        brands: ids,
        candidates: found,
        verified: records.length,
        added,
      });
    } catch (e) {
      persistError = String(e.message || e);
    }
  }

  return {
    ok: true,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    duration_seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
    window_days: days,
    // The exact instant the window opens, so "to the minute" is checkable
    // rather than asserted.
    window_start: new Date(Date.now() - days * 864e5).toISOString(),
    brands: ids,
    channels: want,
    candidates_found: found,
    records_verified: records.length,
    rejected: (verified.rejections || []).length,
    rejection_reasons: [...new Set((verified.rejections || []).map(r => r.reason))].slice(0, 12),
    added_to_store: added,
    store_total: storeTotal,
    persisted,
    persist_error: persistError,
    persist_note: persisted
      ? null
      : "This deployment has no writable filesystem, so these records were returned but not stored. They are live and real; they will not be here on the next page load.",
    per_source: perSource,
    gaps,
    records,
  };
}

/**
 * Rebuild data/ after a refresh. Local only — it spawns build.js, which needs a
 * filesystem. Returns a receipt rather than throwing, because a failed rebuild
 * must not lose the refresh that already succeeded.
 */
function rebuild({ log = () => {} } = {}) {
  return new Promise(resolve => {
    if (!deployment.capabilities().spawn_collectors) {
      return resolve({ ok: false, skipped: true, reason: "this deployment cannot spawn a build" });
    }
    const { spawn } = require("child_process");
    const child = spawn(process.execPath, [path.join(ROOT, "collectors", "build.js")], { cwd: ROOT });
    let out = "";
    child.stdout.on("data", d => { out += d.toString(); });
    child.stderr.on("data", d => { out += d.toString(); });
    child.on("close", code => resolve({ ok: code === 0, code, log: out.split("\n").filter(Boolean).slice(-12) }));
    child.on("error", e => resolve({ ok: false, code: -1, error: String(e.message) }));
  });
}

module.exports = { refresh, rebuild, sweepX, sweepLinkedIn };
