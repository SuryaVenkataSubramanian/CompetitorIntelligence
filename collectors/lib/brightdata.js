/**
 * Bright Data client — Web Scraper API (datasets v3).
 *
 * WHAT THIS ACCOUNT CAN AND CANNOT DO (probed 2026-09-01, evidence in
 * collectors/store/brightdata-capabilities.json — re-run `npm run brightdata:probe`):
 *
 *   WORKS   POST /datasets/v3/trigger  → snapshot_id
 *           GET  /datasets/v3/progress/:id
 *           GET  /datasets/v3/snapshot/:id?format=json
 *           GET  /datasets/list        (1755-dataset catalogue)
 *
 *   BLOCKED POST /request  — the SERP API / Web Unlocker endpoint.
 *           /zone/get_active_zones returns [] and /status reports
 *           can_make_requests:false, auth_fail_reason:"zone_not_found".
 *           The account has NO zone provisioned, so arbitrary-URL fetching and
 *           Google SERP/AI-Overview scraping through Bright Data are
 *           unavailable. Creating a zone is a billable account change, so it is
 *           reported rather than done silently.
 *
 *   ABSENT  No ChatGPT / Claude / Gemini / Perplexity scraper dataset exists in
 *           this account's catalogue, so LLM answers cannot be measured through
 *           Bright Data either.
 *
 * Every one of those limits surfaces in the dashboard as an explicit
 * "not available — <reason>", never as a zero. A zero would say "we looked and
 * found nothing", which is a different and false claim.
 *
 * No LLM is involved in this file. It reports what the wire returned.
 */
const fs = require("fs");
const path = require("path");
const { fetchUrl, fetchJson, sleep } = require("./fetch");

const CAPS_PATH = path.join(__dirname, "..", "store", "brightdata-capabilities.json");
const API = "https://api.brightdata.com";

/**
 * Datasets this project uses, with the discovery modes the API itself
 * enumerated when asked. Sending a deliberately invalid `discover_by` makes
 * Bright Data list the valid ones, which is how each entry below was
 * established — not from documentation that may have drifted.
 */
const DATASETS = {
  linkedin_posts: {
    id: "gd_lyy3tktm25m4avu764",
    label: "LinkedIn posts",
    discover: ["url", "profile_url", "company_url"],
    // No keyword discovery. Keyword coverage therefore has to come from a web
    // search that finds linkedin.com/posts URLs, which are then scraped in
    // `url` mode. That indirection is why linkedin-brightdata.js has a
    // search-discovery stage.
  },
  reddit_posts: {
    id: "gd_lvz8ah06191smkebj4",
    label: "Reddit posts",
    discover: ["subreddit_url", "keyword", "author_url"],
  },
  youtube_videos: {
    id: "gd_lk56epmy2i5g7lzu0k",
    label: "YouTube videos",
    discover: ["keyword", "url", "search_filters", "hashtag", "explore", "podcast_url"],
  },
  x_posts: {
    id: "gd_lwxkxvnf1cynvib9co",
    label: "X (Twitter) posts",
    discover: ["profile_url", "profiles_array"],
  },
  instagram_posts: {
    id: "gd_lk5ns7kz21pck8jpis",
    label: "Instagram posts",
    discover: ["url"],
  },
};

function token() {
  return process.env.BRIGHTDATA_API_KEY || "";
}

function configured() {
  return !!token();
}

function headers(extra = {}) {
  return { Authorization: "Bearer " + token(), ...extra };
}

/** Cached capability file, or null if the probe has never run. */
function capabilities() {
  try {
    return JSON.parse(fs.readFileSync(CAPS_PATH, "utf8"));
  } catch (e) {
    return null;
  }
}

/**
 * Is arbitrary-URL fetching through Bright Data available?
 * Returns a reason string when it is not, so callers can report the blocker
 * verbatim instead of inventing an empty result.
 */
function requestApi() {
  const caps = capabilities();
  if (!configured()) return { available: false, reason: "BRIGHTDATA_API_KEY is not set." };
  if (!caps) return { available: false, reason: "Bright Data has not been probed yet — run `npm run brightdata:probe`." };
  const r = caps.request_api || {};
  if (r.available && r.zone) return { available: true, zone: r.zone };
  return {
    available: false,
    reason:
      "The Bright Data account has no proxy/SERP zone provisioned " +
      "(/zone/get_active_zones returned an empty list and /status reports " +
      'can_make_requests:false, auth_fail_reason:"zone_not_found"). Create a ' +
      "SERP API or Web Unlocker zone in the Bright Data control panel, then " +
      "re-run `npm run brightdata:probe`.",
  };
}

/* --------------------------------------------------------------- scraper API */

/**
 * Start a collection. Returns { ok, snapshot_id } or { ok:false, error }.
 *
 * `discoverBy` selects a discovery collector (see DATASETS[].discover). Omit it
 * to scrape the exact URLs supplied.
 */
async function trigger(datasetId, inputs, { discoverBy = null, includeErrors = true } = {}) {
  if (!configured()) return { ok: false, error: "BRIGHTDATA_API_KEY is not set" };
  if (!Array.isArray(inputs) || !inputs.length) return { ok: false, error: "no inputs" };

  const qs = new URLSearchParams({ dataset_id: datasetId });
  if (includeErrors) qs.set("include_errors", "true");
  if (discoverBy) {
    qs.set("type", "discover_new");
    qs.set("discover_by", discoverBy);
  }

  const r = await fetchUrl(`${API}/datasets/v3/trigger?${qs}`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(inputs),
    retries: 1,
    timeout: 60000,
  });

  if (!r.ok) {
    return { ok: false, status: r.status, error: (r.body || r.error || "").slice(0, 400) };
  }
  let sid = null;
  try { sid = JSON.parse(r.body).snapshot_id; } catch (e) { /* fall through */ }
  if (!sid) return { ok: false, status: r.status, error: "no snapshot_id in response: " + (r.body || "").slice(0, 200) };
  return { ok: true, snapshot_id: sid, triggered_at: new Date().toISOString() };
}

/**
 * Poll a snapshot to completion, then download it.
 *
 * Deliberately patient: the user's instruction is that accuracy matters more
 * than speed, and a discovery collection over a company page legitimately takes
 * minutes. A timeout returns { ok:false, status:"timeout" } — never a partial
 * result dressed up as a complete one.
 */
async function waitSnapshot(snapshotId, { maxMs = 15 * 60 * 1000, everyMs = 15000, onTick = null } = {}) {
  const started = Date.now();
  let last = null;

  while (Date.now() - started < maxMs) {
    const p = await fetchJson(`${API}/datasets/v3/progress/${snapshotId}`, {
      headers: headers(), retries: 1, timeout: 30000,
    });
    last = p.json || {};
    if (onTick) onTick(last);

    if (last.status === "ready") {
      // NDJSON rather than a single JSON array, deliberately. A 200-post
      // snapshot exceeds 4MB, and one truncated array is unparseable in its
      // entirety — 200 good records lost to one cut string. With one record per
      // line, a short read costs only the final partial line, and the loss is
      // counted rather than hidden.
      const s = await fetchUrl(`${API}/datasets/v3/snapshot/${snapshotId}?format=jsonl`, {
        headers: headers(),
        retries: 2,
        timeout: 180000,
        maxBytes: 128 * 1024 * 1024,
      });
      if (!s.ok && !s.truncated) {
        return { ok: false, status: "download_failed", error: (s.body || s.error || "").slice(0, 300) };
      }

      const rows = [];
      let unparseable = 0;
      for (const line of String(s.body || "").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try { rows.push(JSON.parse(t)); } catch (e) { unparseable++; }
      }
      if (!rows.length) {
        return {
          ok: false,
          status: "parse_failed",
          error: `no parseable NDJSON records in ${s.bytes} bytes` +
            (s.truncated ? ` (response was truncated at ${s.bytes} of ${s.total_bytes} bytes)` : ""),
        };
      }

      return {
        ok: true,
        status: "ready",
        rows,
        records: last.records ?? rows.length,
        errors: last.errors ?? 0,
        // Reported so a partial download is visible in the collector log and the
        // Data Quality panel rather than looking like a smaller result set.
        truncated: !!s.truncated,
        unparseable_lines: unparseable,
        // Provenance: the snapshot id is a durable Bright Data receipt that can
        // be re-downloaded to re-check any record we stored.
        snapshot_id: snapshotId,
        content_sha256: s.content_sha256,
        downloaded_at: new Date().toISOString(),
      };
    }
    if (last.status === "failed") {
      return { ok: false, status: "failed", error: last.error || "collection failed", snapshot_id: snapshotId };
    }
    await sleep(everyMs);
  }
  return {
    ok: false,
    status: "timeout",
    snapshot_id: snapshotId,
    error: `still ${last && last.status} after ${Math.round(maxMs / 1000)}s — snapshot may complete later`,
    last_progress: last,
  };
}

/** trigger + wait, the common case. */
async function collect(datasetId, inputs, opts = {}) {
  const t = await trigger(datasetId, inputs, opts);
  if (!t.ok) return { ok: false, ...t };
  const w = await waitSnapshot(t.snapshot_id, opts);
  return { ...w, triggered_at: t.triggered_at, snapshot_id: t.snapshot_id };
}

module.exports = {
  DATASETS,
  configured,
  capabilities,
  requestApi,
  trigger,
  waitSnapshot,
  collect,
  CAPS_PATH,
};
