/**
 * Apify — actor runs for the channels no keyless source can reach.
 *
 * WHY THIS EARNS A PLACE WHEN THIRTEEN KEYLESS SOURCES ALREADY EXIST
 * ------------------------------------------------------------------
 * It does not compete with them. It fills the two holes they cannot:
 *
 *   X          twitterapi.io is at -518 credits, so the channel is dark. The
 *              keyless layer has no route to X at all — Bluesky is a different
 *              network, not a mirror.
 *   LinkedIn   the SerpAPI `site:linkedin.com/posts` route finds posts but
 *              carries NO DATE and no author: Google's snippet has neither, and
 *              19 of 38 authors had to be recovered by regex from the page text.
 *              MEASURED against the same brand, Apify returned exact ISO
 *              timestamps (2026-09-29T14:02:37) and real author names for every
 *              post. That is a strict upgrade, not a duplicate.
 *
 * Web is deliberately NOT routed here. Thirteen keyless sources already cover
 * it, and the budget below is far too small to spend on ground we hold.
 *
 * THE BUDGET IS THE WHOLE DESIGN
 * ------------------------------
 * MEASURED on this account (FREE plan, $5/month):
 *
 *   apidojo/tweet-scraper              $0.0020 for  5 tweets  -> $0.0004/tweet
 *   harvestapi/linkedin-post-search    $0.0100 for  5 posts   -> $0.0020/post
 *
 * A full seven-brand sweep at 20 tweets and 10 posts each is about $0.20. That
 * is TWENTY-FIVE SWEEPS A MONTH — fewer than one a day. The refresh cron runs
 * every two hours, which would be 360 a month and would exhaust the plan in
 * roughly thirty-six hours.
 *
 * So this module refuses by default and is paced, rather than being called
 * freely and failing later. Every refusal is a GAP with a reason, never a zero:
 * "we did not spend money on this" and "nobody mentioned you" must not render
 * the same way.
 */
const path = require("path");
const { fetchUrl, fetchJson } = require("./fetch");
const { readJson, writeJson, STORE_DIR } = require("./store");

const API = "https://api.apify.com/v2";
const SPEND_FILE = path.join(STORE_DIR, "apify-spend.json");

/* Actors, with their measured cost so the guard can reason before spending. */
const ACTORS = {
  x: {
    id: "apidojo~tweet-scraper",
    label: "X / Twitter (apidojo/tweet-scraper)",
    usd_per_item: 0.0004,
    channel: "x",
  },
  linkedin: {
    id: "harvestapi~linkedin-post-search",
    label: "LinkedIn posts (harvestapi/linkedin-post-search)",
    usd_per_item: 0.0020,
    channel: "linkedin",
  },
};

function configured() {
  return !!process.env.APIFY_TOKEN;
}

function credentialStatus() {
  if (!configured()) {
    return {
      ok: false,
      reason: "APIFY_TOKEN is not set — the X and LinkedIn upgrade routes are unavailable.",
      how_to_enable: "Add APIFY_TOKEN to .env (console.apify.com/settings/integrations).",
    };
  }
  return { ok: true, reason: null };
}

function headers(extra = {}) {
  return Object.assign({ Authorization: "Bearer " + process.env.APIFY_TOKEN }, extra);
}

/* ------------------------------------------------------------ spend ledger */

function readSpend() {
  const s = readJson(SPEND_FILE, null) || {};
  return {
    month: s.month || new Date().toISOString().slice(0, 7),
    spent_usd: Number(s.spent_usd || 0),
    runs: Array.isArray(s.runs) ? s.runs : [],
    last_sweep_at: s.last_sweep_at || null,
  };
}

function recordSpend(actorKey, usd, items, basis = "measured") {
  const s = readSpend();
  const month = new Date().toISOString().slice(0, 7);
  // A new calendar month resets the ledger, because the plan's quota does.
  if (s.month !== month) { s.month = month; s.spent_usd = 0; s.runs = []; }
  s.spent_usd = Number((s.spent_usd + (Number(usd) || 0)).toFixed(6));
  s.runs.unshift({ at: new Date().toISOString(), actor: actorKey, usd: Number(usd) || 0, items: items || 0, cost_basis: basis });
  s.runs = s.runs.slice(0, 200);
  writeJson(SPEND_FILE, s);
  return s;
}

function markSweep() {
  const s = readSpend();
  s.last_sweep_at = new Date().toISOString();
  writeJson(SPEND_FILE, s);
}

/**
 * Live monthly usage from Apify, which is authoritative.
 *
 * The local ledger only sees runs THIS deployment made; the account may also be
 * spent from the console or another machine. Trusting the local number alone is
 * how a budget guard lets a plan run dry while reporting headroom.
 */
async function usage() {
  if (!configured()) return { ok: false, ...credentialStatus() };
  const r = await fetchJson(`${API}/users/me/usage/monthly`, { headers: headers(), retries: 1, timeout: 25000 });
  if (!r.ok || !r.json || !r.json.data) {
    return { ok: false, reason: `Apify usage endpoint HTTP ${r.status}` };
  }
  const used = Number(
    r.json.data.totalUsageCreditsUsdAfterVolumeDiscount ??
    r.json.data.totalUsageCreditsUsd ?? 0
  );
  const limit = Number(process.env.APIFY_MONTHLY_BUDGET_USD || 5);
  const reserve = Number(process.env.APIFY_MIN_RESERVE_USD || 0.5);
  return {
    ok: true,
    used_usd: used,
    limit_usd: limit,
    reserve_usd: reserve,
    spendable_usd: Math.max(0, limit - reserve - used),
    local_ledger: readSpend(),
  };
}

/**
 * How long between unattended Apify sweeps.
 *
 * $5 divided by ~$0.20 a sweep is 25 sweeps a month. A 2-hourly cron would
 * spend that in a day and a half, so an unattended run is paced to roughly one
 * a day and a human pressing Refresh can force it.
 */
const MIN_GAP_MS = Number(process.env.APIFY_MIN_GAP_HOURS || 22) * 3600e3;

function pacing({ force = false } = {}) {
  if (force) return { ok: true, throttled: false };
  const last = readSpend().last_sweep_at;
  if (!last) return { ok: true, throttled: false };
  const since = Date.now() - Date.parse(last);
  if (since >= MIN_GAP_MS) return { ok: true, throttled: false };
  const hrs = Math.max(1, Math.round((MIN_GAP_MS - since) / 36e5));
  return {
    ok: false,
    throttled: true,
    reason:
      `paced: an Apify sweep costs about $0.20 and the plan allows $${process.env.APIFY_MONTHLY_BUDGET_USD || 5} a month, ` +
      `which is fewer than one sweep a day. Last run ${Math.round(since / 36e5)}h ago; next in ~${hrs}h. ` +
      `Press Refresh to run it now.`,
  };
}

/**
 * Run one actor and return its dataset items.
 *
 * Budget is checked BEFORE the call, not after: Apify bills for the run whether
 * or not the caller likes the result, so a guard that checks afterwards is not
 * a guard.
 */
async function runActor(actorKey, input, { maxItems = 20, log = () => {} } = {}) {
  const cred = credentialStatus();
  if (!cred.ok) return { ok: false, skipped: "not_configured", reason: cred.reason, items: [] };

  const actor = ACTORS[actorKey];
  if (!actor) return { ok: false, reason: `unknown actor key "${actorKey}"`, items: [] };

  const u = await usage();
  if (!u.ok) return { ok: false, reason: u.reason, items: [] };

  const estimate = actor.usd_per_item * maxItems;
  if (estimate > u.spendable_usd) {
    return {
      ok: false,
      budget_stop: true,
      items: [],
      reason:
        `Apify budget: this run would cost about $${estimate.toFixed(4)} and only ` +
        `$${u.spendable_usd.toFixed(4)} is spendable ($${u.used_usd.toFixed(2)} used of ` +
        `$${u.limit_usd} this month, $${u.reserve_usd} held back). This is a SPEND STOP, ` +
        `not an absence of mentions.`,
    };
  }

  const body = JSON.stringify(input);
  const url = `${API}/acts/${actor.id}/run-sync-get-dataset-items?timeout=240&memory=1024`;
  const started = Date.now();

  const r = await fetchUrl(url, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }),
    body,
    retries: 0,
    timeout: 280000,
    maxBytes: 16 * 1024 * 1024,
  });

  if (!r.ok) {
    // A 400 is an input-shape error and costs nothing — worth saying, because
    // it is fixable in code rather than by topping up.
    const detail = String(r.body || "").replace(/\s+/g, " ").slice(0, 200);
    return {
      ok: false,
      status: r.status,
      items: [],
      reason: r.status === 400
        ? `Apify rejected the input (no charge): ${detail}`
        : `Apify ${actor.id} HTTP ${r.status}: ${detail}`,
    };
  }

  let items = [];
  try { items = JSON.parse(r.body); } catch (e) {
    return { ok: false, items: [], reason: `Apify returned unparseable JSON: ${String(e.message || e)}` };
  }
  if (!Array.isArray(items)) items = [];

  /* SENTINEL ROWS ARE NOT RESULTS.
   *
   * MEASURED: apidojo/tweet-scraper answers a query with no matches by
   * returning TEN objects of the shape {noResults: true} rather than an empty
   * array. The mapping layer already skipped them for having no text, so no bad
   * data reached the store — but they were counted as ten items, logged as ten
   * items, and BILLED as ten items in the cost estimate. A genuine zero was
   * being reported as a paid result set.
   *
   * Dropped here, at the boundary, so every caller sees a real count. */
  const before = items.length;
  items = items.filter(x => x && typeof x === "object" && !x.noResults && Object.keys(x).length > 1);
  const sentinels = before - items.length;

  /* Bill from the actual run where Apify has computed it yet.
   *
   * MEASURED: immediately after run-sync-get-dataset-items, the run record's
   * usageTotalUsd is frequently still 0 — the platform settles cost slightly
   * after the dataset is returned. Recording that 0 as fact would make the
   * local ledger claim the sweep was free.
   *
   * This does NOT weaken the guard: runActor decides using usage(), which reads
   * Apify's own authoritative monthly total. The ledger is a local record, and
   * an estimate labelled as one beats a zero presented as truth. */
  const measured = await lastRunCost(actor.id);
  // Estimate from REAL items only: a no-results run has nothing to pay per.
  const estimated = actor.usd_per_item * items.length;
  const spent = measured > 0 ? measured : estimated;
  recordSpend(actorKey, spent, items.length, measured > 0 ? "measured" : "estimated");
  log(`      apify ${actorKey}: ${items.length} item(s), $${(spent || 0).toFixed(4)}${measured > 0 ? "" : " (est)"}${sentinels ? `, ${sentinels} no-result row(s) discarded` : ""}, ${((Date.now() - started) / 1000).toFixed(1)}s`);

  return { ok: true, items, cost_usd: spent, actor: actor.id, empty_result: sentinels > 0 && items.length === 0 };
}

/** What the most recent run of an actor actually cost. */
async function lastRunCost(actorId) {
  try {
    const r = await fetchJson(`${API}/actor-runs?limit=1&desc=1`, { headers: headers(), retries: 0, timeout: 20000 });
    const run = r.json && r.json.data && r.json.data.items && r.json.data.items[0];
    return run && run.usageTotalUsd != null ? Number(run.usageTotalUsd) : 0;
  } catch (e) {
    return 0;
  }
}

module.exports = { ACTORS, configured, credentialStatus, usage, runActor, pacing, markSweep, readSpend };
