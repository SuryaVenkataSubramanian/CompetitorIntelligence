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
 * Who wrote a LinkedIn post, from what the SERP result already tells us.
 *
 * The digest format the team reads is "PRIORITY - CHANNEL - AUTHOR - AGE", and
 * every LinkedIn row was rendering with no author because the candidate set
 * author:null. The name was there the whole time, in two places:
 *
 *   the title   Google renders LinkedIn posts as "Saravana Kumar's Post",
 *               "Saravana Kumar posted this", or "Name - Post title".
 *   the URL     /posts/<author-slug>_<topic-slug>-activity-<id>
 *
 * Both are published by the source, so neither is a guess. The title is tried
 * first because it carries real capitalisation and diacritics; the slug is the
 * fallback and is reconstructed conservatively.
 *
 * Returns null rather than something plausible when neither pattern matches —
 * an invented author on a real post is worse than a blank.
 */
function linkedinAuthor(title, url) {
  const t = String(title || "").trim();

  // "Saravana Kumar's Post" / "Han Wang's Post on ..."
  let m = /^(.+?)(?:'|’)s\s+Post/i.exec(t);
  if (m) return m[1].trim();

  // "Saravana Kumar posted this"
  m = /^(.+?)\s+posted\s+this/i.exec(t);
  if (m) return m[1].trim();

  // "Robert Hean - Confluence for Support Teams"  (name, then a dash)
  m = /^([A-Z][\p{L}.'’-]+(?:\s+[A-Z][\p{L}.'’-]+){1,3})\s+[-–]\s+/u.exec(t);
  if (m) return m[1].trim();

  /* The URL slug. LinkedIn builds it from the author's profile handle, so
   * "madalin-gheorghe-5026884a" is a real person; the trailing hex id and any
   * role words are stripped. Only used when it looks like a name — a handle
   * that is mostly digits is not one. */
  try {
    const seg = decodeURIComponent(new URL(url).pathname).split("/posts/")[1] || "";
    const handle = seg.split("_")[0];
    if (!handle) return null;
    const parts = handle.split("-").filter(w => /^[\p{L}]{2,}$/u.test(w));
    if (parts.length < 2) return null;
    return parts.slice(0, 3)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  } catch (e) {
    return null;
  }
}


/**
 * LinkedIn, via the one provider left that can reach it.
 *
 * LinkedIn has no usable public API here, Bright Data's dataset suspended with
 * the account, and DuckDuckGo refuses site: queries outright. SerpAPI is real
 * Google and does honour site:, which makes it the only working route — but the
 * plan allows 250 searches a MONTH, so this spends exactly one query per brand
 * and only when the caller actually asked for LinkedIn.
 */
/**
 * How long to wait between unattended LinkedIn sweeps.
 *
 * SerpAPI's free plan is 250 searches a MONTH and LinkedIn costs one per brand,
 * so seven per sweep. The refresh cron runs every 2 hours — twelve sweeps a day,
 * 84 searches a day — which drains a month's quota in THREE DAYS and then
 * silently stops finding LinkedIn posts at all.
 *
 * So an unattended sweep runs LinkedIn at most once per this interval, which
 * paces seven searches a day and makes the quota last the month. A person
 * pressing Refresh passes force:true and is never throttled — they are watching,
 * they asked, and it is one query.
 */
const LINKEDIN_MIN_GAP_MS = 20 * 3600e3;

async function sweepLinkedIn({ brands, log, force = false, days = 7 }) {
  const out = { candidates: [], gaps: [], ran: false, reason: null, throttled: false };
  const serpapi = require("./serpapi");
  if (!serpapi.configured()) { out.reason = serpapi.credentialStatus().reason; return out; }

  const freshsources = require("./freshsources");
  const state = freshsources.loadState();
  const last = state.last_linkedin_sweep ? Date.parse(state.last_linkedin_sweep) : 0;
  const since = Date.now() - last;

  if (!force && last && since < LINKEDIN_MIN_GAP_MS) {
    const hrs = Math.round((LINKEDIN_MIN_GAP_MS - since) / 36e5);
    out.throttled = true;
    out.reason =
      "paced: LinkedIn costs one SerpAPI search per brand and the plan allows 250 a month. " +
      "Last swept " + Math.round(since / 36e5) + "h ago; next unattended sweep in ~" + hrs + "h. " +
      "Press Refresh to run it now.";
    log("      linkedin: " + out.reason);
    return out;
  }

  const probe = await serpapi.probe();
  if (!probe.ok) { out.reason = probe.reason; return out; }

  for (const id of brands) {
    const b = brand(id);
    const q = 'site:linkedin.com/posts "' + b.aliases[0] + '"';
    /* ASK FOR RECENT POSTS, not for every post that exists.
     *
     * Without this the query returned LinkedIn posts from 2024 and 2025 — real,
     * correctly dated, and useless for a 7-day view. 44 records collected, 1
     * inside the window. Google maps the window onto its own buckets, so a
     * 7-day ask becomes qdr:w. */
    const recency = days <= 1 ? "d" : days <= 7 ? "w" : days <= 31 ? "m" : "y";
    const r = await serpapi.search(q, { log, num: 20, recency });
    if (!r.ok) { out.gaps.push({ brand_id: id, reason: "SerpAPI: " + String(r.error).slice(0, 90) }); continue; }

    for (const hit of r.results || []) {
      if (!hit.url || !/linkedin\.com\/posts/i.test(hit.url)) continue;
      const text = [hit.title, hit.snippet, hit.content].filter(Boolean).join(". ");

      /* THE ALIAS MAY BE IN THE URL RATHER THAN THE SNIPPET.
       *
       * Google truncates a LinkedIn snippet to ~150 characters, and a post that
       * mentions the brand once in its third paragraph shows a snippet that
       * never repeats it. Requiring the alias in the snippet alone dropped real
       * posts — measured: 27 SERP results for three brands yielded 4 candidates.
       *
       * LinkedIn post URLs embed an author-and-topic slug
       * (/posts/document360_apidocumentation-apis-...), so the URL itself
       * frequently names the brand. That is still evidence from the source
       * rather than an assumption, so it counts. The shared pipeline then
       * confirms the mention against the fetched page before anything is
       * stored, so a URL-only match cannot become a record on its own. */
      const inText = freshsources.firstAliasIn(text, id);
      const slug = decodeURIComponent(hit.url).replace(/[^A-Za-z0-9]+/g, " ");
      const inUrl = freshsources.firstAliasIn(slug, id);
      if (!inText && !inUrl) continue;

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
        author: linkedinAuthor(hit.title, hit.url),
        extra: {
          serp_position: hit.position || hit.rank || null,
          matched_alias: inText || inUrl,
          // Which of the two matched, so a reader can weigh it.
          matched_in: inText ? "title/snippet" : "post URL slug",
        },
      });
    }
    out.ran = true;
    log("      linkedin: " + b.name + " — " + out.candidates.filter(c => c.brand_id === id).length + " post(s) via SerpAPI");
  }

  if (out.ran) {
    const st = freshsources.loadState();
    st.last_linkedin_sweep = new Date().toISOString();
    freshsources.saveState(st);
  }
  return out;
}

/* -------------------------------------------------------------- blog feeds */

/**
 * First-party blog and changelog RSS.
 *
 * THIS WAS MISSING FROM THE LIVE SWEEP ENTIRELY, and it is why the Blog column
 * read 0 for the last 7 days while four brands were publishing. The adapter
 * existed and worked — it was simply only wired into collect.js, the slow
 * full-backfill path that nobody runs on a schedule any more.
 *
 * It belongs here more than almost anything else does: it is first-party, it
 * carries exact publication dates, it needs no credential and no proxy, and it
 * is not rate limited. The highest-quality source in the project was absent
 * from the path that actually keeps the dashboard current.
 *
 * Brands with no resolved feed (GitBook, Guru, KnowledgeOwl) report a gap
 * rather than contributing a silent zero.
 */
async function sweepBlogs({ brands, sinceDays, log }) {
  const out = { candidates: [], gaps: [], ran: false, reason: null };
  try {
    const adapter = require("../adapters/blogfeed");
    const r = await adapter.collect({ sinceDays, log });
    // The adapter has no brand filter of its own, so apply the caller's here.
    out.candidates = (r.candidates || []).filter(c => !brands || brands.includes(c.brand_id));
    out.gaps = (r.gaps || []).filter(g => !brands || !g.brand_id || brands.includes(g.brand_id));
    out.ran = true;
  } catch (e) {
    out.reason = "blog sweep threw: " + String(e.message || e);
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
  // A person pressing Refresh is never throttled on the metered routes: they
  // are watching, they asked for it, and it is a handful of queries. An
  // unattended cron IS throttled, because it runs twelve times a day.
  force = false,
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

  /* 3. Blog and changelog RSS. Free, first-party, exact dates — it should have
   *    been here from the start. Its absence is why Blog read 0 for 7 days. */
  if (!want || want.includes("blog")) {
    log("  > Brand blog / changelog RSS");
    const bl = await sweepBlogs({ brands: ids, sinceDays: days, log });
    candidates = candidates.concat(bl.candidates);
    gaps.push(...bl.gaps.map(g => Object.assign({ source: "blogfeed" }, g)));
    perSource.push({
      id: "blogfeed", label: "Brand blog / changelog RSS", tier: "primary",
      candidates: bl.candidates.length, gaps: bl.gaps.length, ok: bl.ran,
      error: bl.ran ? null : bl.reason,
    });
  }

  /* 4. LinkedIn.
   *
   *    THE CONDITION USED TO BE `want && want.includes("linkedin")`, which is
   *    inverted: with no channel filter — the normal case, and what the cron
   *    and the digest both do — `want` is null, so LinkedIn NEVER RAN. One
   *    LinkedIn record in seven days across all seven brands was not a quiet
   *    week on LinkedIn; it was a channel that was never queried.
   *
   *    Now it runs by default, paced so it cannot drain the monthly quota. */
  if (!want || want.includes("linkedin")) {
    log("  > LinkedIn (SerpAPI site: query)");
    const li = await sweepLinkedIn({ brands: ids, log, force, days });
    candidates = candidates.concat(li.candidates);
    gaps.push(...li.gaps.map(g => Object.assign({ source: "linkedin_serpapi" }, g)));
    perSource.push({
      id: "linkedin_serpapi", label: "LinkedIn (SerpAPI)", tier: "metered",
      candidates: li.candidates.length, gaps: li.gaps.length,
      // Throttled is not failed. It must not render as a broken source.
      ok: li.ran || li.throttled,
      throttled: !!li.throttled,
      error: li.ran ? null : li.reason,
    });
    if (li.throttled) gaps.push({ source: "linkedin_serpapi", reason: li.reason });
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

  /* A receipt, so the dashboard can say WHEN each channel was last asked.
   * Written even when nothing was found — that is precisely the case where
   * knowing the sweep ran is the whole point. */
  try {
    const { writeJson, STORE_DIR } = require("./store");
    writeJson(path.join(STORE_DIR, "live-sweep-receipt.json"), {
      finished_at: new Date().toISOString(),
      window_days: days,
      brands: ids,
      channels: want || "all",
      candidates_found: found,
      records_verified: records.length,
      added: added,
      per_source: perSource,
      gaps: gaps.slice(0, 40),
    });
  } catch (e) { /* a missing receipt must never fail the sweep */ }

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

module.exports = { refresh, rebuild, sweepX, sweepLinkedIn, sweepBlogs, linkedinAuthor };
