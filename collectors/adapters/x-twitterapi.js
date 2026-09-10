/**
 * Adapter: X / Twitter via twitterapi.io
 *
 * THIS IS THE THIRD ATTEMPT AT THE X CHANNEL, AND THE FIRST GOOD ONE
 * -----------------------------------------------------------------
 *   x_twikit.js       drove a real X account (username + password). Never
 *                     collected once: the credential is a personal login, it
 *                     cannot go to a hosted deployment, and the flow dies on a
 *                     CAPTCHA or 2FA prompt. Retired.
 *   x-brightdata.js   no account needed, and it worked — for one afternoon.
 *                     The Bright Data account then suspended mid-session.
 *                     Also profile-only: the dataset offered no keyword search.
 *   this one          no account, and it HAS keyword search.
 *
 * PROBED 2026-09-10, all three endpoints returning HTTP 200:
 *   /twitter/tweet/advanced_search   keyword search, 20 tweets for "Document360"
 *   /twitter/user/last_tweets        owned timeline, 20 tweets
 *   /twitter/user/info               profile metadata
 *
 * Newest tweet was 43 hours old against a store whose newest X record was 10
 * days stale, and every tweet carries an exact createdAt plus like, retweet,
 * reply, quote, view and bookmark counts.
 *
 * WHY KEYWORD SEARCH CHANGES THE NUMBERS
 * --------------------------------------
 * Bright Data could only read a timeline, so X coverage was owned-channel
 * activity: what each company posted. A stranger complaining about Document360
 * was invisible. `advanced_search` finds those, which is the half of social
 * listening that actually matters competitively — so this adapter runs BOTH
 * stages and records which one found each tweet.
 *
 * PAGINATION IS CURSOR-BASED and bounded here. The API returns
 * has_next_page + next_cursor; a runaway follow would burn the plan on one
 * brand, so each query stops at MAX_PAGES and reports if more remained.
 */
const { load } = require("../lib/env");
const { fetchJson } = require("../lib/fetch");
const { allBrands, brandOrder, matchBrand, brand } = require("../lib/brands");
const {
  classifyType, detectBuyingIntent, detectComparisons, detectEvent,
} = require("../lib/classify");
const { toIsoDate } = require("../lib/verify");

load();

const BASE = "https://api.twitterapi.io";
const MAX_PAGES = 3;          // per query; 20 tweets a page
const PAGE_GAP_MS = 400;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function credentialStatus() {
  const key = process.env.TWITTERAPI_IO_KEY || "";
  if (!key) {
    return {
      ok: false,
      reason: "TWITTERAPI_IO_KEY not set — the X channel is not connected.",
      how_to_enable:
        "Add TWITTERAPI_IO_KEY to .env (from the twitterapi.io dashboard — it is a " +
        "separate value from the user ID), then run: npm run collect:x",
    };
  }
  return { ok: true, reason: null };
}

/**
 * Remaining credits.
 *
 * MEASURED: when the plan runs out, every endpoint answers HTTP 402
 *   {"error":"Unauthorized","message":"Credits is not enough.Please recharge"}
 * and /oapi/my/info reported recharge_credits: -518 — it goes NEGATIVE rather
 * than stopping at zero. Without checking first, an exhausted plan produced
 * four consecutive 402s that looked like four per-brand failures instead of
 * one account-level stop.
 */
async function credits() {
  const r = await fetchJson(`${BASE}/oapi/my/info`, { headers: headers(), retries: 1, timeout: 30000 });
  if (!r.ok || !r.json) return { ok: false, reason: `credit check failed: HTTP ${r.status}` };
  const c = Number(r.json.recharge_credits ?? 0) + Number(r.json.total_bonus_credits ?? 0);
  return { ok: true, credits: c, exhausted: c <= 0 };
}

function headers() {
  return { "X-API-Key": process.env.TWITTERAPI_IO_KEY };
}

/** One page of any endpoint. Returns { ok, tweets, cursor, hasNext, error }. */
async function page(url) {
  const r = await fetchJson(url, { headers: headers(), retries: 1, timeout: 40000, maxBytes: 16 * 1024 * 1024 });
  if (!r.ok || !r.json) {
    return { ok: false, tweets: [], error: `HTTP ${r.status}` };
  }
  const j = r.json;
  // The two endpoints wrap their payload differently: advanced_search returns
  // `tweets` at the top level, last_tweets nests under `data`.
  const tweets = j.tweets || (j.data && (j.data.tweets || (Array.isArray(j.data) ? j.data : null))) || [];
  // A non-success status inside HTTP 200 must not read as "no tweets".
  if (j.status && j.status !== "success" && !tweets.length) {
    return { ok: false, tweets: [], error: `${j.status}: ${j.msg || j.message || "unknown"}` };
  }
  return {
    ok: true,
    tweets: Array.isArray(tweets) ? tweets : [],
    cursor: j.next_cursor || null,
    hasNext: !!j.has_next_page,
  };
}

/** Follow the cursor, bounded. */
async function paged(buildUrl, { maxPages = MAX_PAGES } = {}) {
  const all = [];
  let cursor = null;
  let pages = 0;
  let truncated = false;
  let error = null;

  while (pages < maxPages) {
    const r = await page(buildUrl(cursor));
    pages++;
    if (!r.ok) { error = r.error; break; }
    all.push(...r.tweets);
    if (!r.hasNext || !r.cursor) break;
    cursor = r.cursor;
    if (pages >= maxPages) { truncated = true; break; }
    await sleep(PAGE_GAP_MS);
  }
  return { tweets: all, pages, truncated, error };
}

/**
 * Which tracked products does this tweet mention?
 * The posting account is recorded where it is one of ours; the text is matched
 * against all seven through the disambiguating matcher either way.
 */
function resolveProducts(tw, handleToBrand) {
  const text = tw.text || "";
  const handle = String((tw.author && tw.author.userName) || "").toLowerCase();
  const owner = handleToBrand.get(handle) || null;

  const out = [];
  if (owner) out.push({ id: owner, confidence: 0.99, via: "posted by the brand's own account" });
  for (const id of brandOrder()) {
    if (id === owner) continue;
    const m = matchBrand(text, id);
    if (m.present) out.push({ id, confidence: 0.9, via: "named in the tweet text", matched: m.matched });
  }
  return out;
}

function toCandidates(tw, { handleToBrand, brands, stage, matchedQuery }) {
  const text = tw.text || "";
  const url = tw.twitterUrl || tw.url;
  if (!url) return [];

  // A retweet with no added text is not an independent mention; it would
  // double-count the original.
  if (tw.type === "retweet" && !text.trim()) return [];

  const published = toIsoDate(tw.createdAt || tw.created_at);
  const products = resolveProducts(tw, handleToBrand);
  const out = [];

  for (const p of products) {
    if (brands && !brands.includes(p.id)) continue;

    const tags = ((tw.extendedEntities && tw.extendedEntities.hashtags) || []).map(h => h.text || h).filter(Boolean);
    const type = classifyType(text, tags);
    const intent = detectBuyingIntent(text, tags);
    const ev = detectEvent(text, tags);
    const cmp = detectComparisons(text, p.id);

    out.push({
      brand_id: p.id,
      channel: ev.is_sponsorship || ev.is_event ? "event" : "x",
      url,
      title: null,
      published_at: published,
      date_method: published ? "twitterapi.io:createdAt" : null,

      // The tweet text as the API returned it — this IS the mention.
      source_text: text || null,
      source_verified: true,
      source_adapter: "x_twitterapi",
      discovered_via: `twitterapi.io ${stage}${matchedQuery ? ` (${matchedQuery})` : ""}`,
      author: (tw.author && (tw.author.name || tw.author.userName)) || null,

      api_source: "twitterapi.io",
      // No sentiment supplied, and none invented here.
      sentiment: null,
      sentiment_method: null,
      confidence_score: p.confidence,
      mention_type: type.type,
      mention_type_basis: `${type.by}: ${type.matched || type.type}`,
      buying_intent: intent.intent,
      buying_intent_basis: intent.matched,
      comparison_products: cmp,
      is_event: ev.is_event,
      is_sponsorship: ev.is_sponsorship,
      event_basis: ev.matched,
      provider_tags: tags,

      engagement: {
        likes: tw.likeCount ?? null,
        reposts: tw.retweetCount ?? null,
        replies: tw.replyCount ?? null,
        quotes: tw.quoteCount ?? null,
        views: tw.viewCount ?? null,
        bookmarks: tw.bookmarkCount ?? null,
        author_followers: (tw.author && tw.author.followers) ?? null,
      },

      extra: {
        tweet_id: tw.id || null,
        author_handle: (tw.author && tw.author.userName) || null,
        author_verified: (tw.author && tw.author.isVerified) ?? null,
        is_reply: !!tw.isReply,
        lang: tw.lang || null,
        tweet_type: tw.type || null,
        product_resolution: p.via,
        brand_match_basis: p.matched || null,
        discovery_stage: stage,
        matched_query: matchedQuery || null,
      },
    });
  }
  return out;
}

module.exports = {
  id: "x_twitterapi",
  label: "X / Twitter (twitterapi.io)",
  channel: "x",
  requires: ["TWITTERAPI_IO_KEY"],
  credentialStatus,
  available() { return credentialStatus(); },

  coverageLimit: {
    note:
      "Two stages: keyword search (advanced_search) finds third-party tweets naming a product, and " +
      "profile search (last_tweets) reads each tracked account's own timeline. Pagination is bounded " +
      "at 3 pages of 20 per query to protect the plan, so a very busy query is a floor rather than a " +
      "total — truncation is reported per query.",
    replaces:
      "x_twikit (account credentials, never collected) and x-brightdata (worked, then the Bright Data " +
      "account suspended; also had no keyword search).",
  },

  connectionStatus() {
    const c = credentialStatus();
    return {
      id: "x_twitterapi",
      label: "X / Twitter (twitterapi.io)",
      connected: c.ok,
      blockers: c.ok ? [] : [c.reason],
      how_to_enable: c.how_to_enable || null,
      fallback_in_use: null,
    };
  },

  async collect({ sinceDays = 90, brands = null, log = () => {} } = {}) {
    const cred = credentialStatus();
    if (!cred.ok) {
      log(`    dormant: ${cred.reason}`);
      return { candidates: [], gaps: [{ brand_id: null, reason: cred.reason }], unavailable: true };
    }

    const credit = await credits();
    if (credit.ok && credit.exhausted) {
      const reason =
        `twitterapi.io credits are exhausted (balance ${credit.credits}). Every endpoint returns ` +
        `HTTP 402 "Credits is not enough. Please recharge", so nothing can be collected. This is a ` +
        `billing stop, NOT an absence of tweets — recharge at twitterapi.io to resume.`;
      log(`    dormant: ${reason}`);
      return { candidates: [], gaps: [{ brand_id: null, reason }], unavailable: true };
    }
    if (credit.ok) log(`    credits: ${credit.credits}`);

    const handleToBrand = new Map();
    for (const b of allBrands()) {
      if (b.x_handle) handleToBrand.set(String(b.x_handle).toLowerCase(), b.id);
    }

    const candidates = [];
    const gaps = [];
    const stats = { keyword_queries: 0, profile_queries: 0, tweets: 0, truncated: [], errors: [] };
    const seen = new Set();

    const add = list => {
      for (const c of list) {
        const k = (c.extra && c.extra.tweet_id ? c.extra.tweet_id : c.url) + "|" + c.brand_id;
        if (seen.has(k)) continue;
        seen.add(k);
        candidates.push(c);
      }
    };

    /* ------------------------------------------------- stage 1: keyword search */
    // The stage Bright Data could not do: tweets from anyone, not just the
    // brand's own account.
    log("    stage 1/2 keyword search");
    for (const b of allBrands()) {
      if (brands && !brands.includes(b.id)) continue;
      // Quoted, so "Document 360" and Document360 are both found as phrases
      // rather than as loose word matches.
      const query = `"${b.name}"`;
      stats.keyword_queries++;
      const r = await paged(cursor =>
        `${BASE}/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Latest` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));

      if (r.error) {
        stats.errors.push(`${b.id} keyword: ${r.error}`);
        gaps.push({ brand_id: b.id, reason: `twitterapi.io keyword search failed: ${r.error}` });
        log(`      ${b.name}: ERROR ${r.error}`);
        continue;
      }
      if (r.truncated) stats.truncated.push(`${b.id} keyword (${MAX_PAGES} pages)`);
      stats.tweets += r.tweets.length;
      const before = candidates.length;
      add(r.tweets.flatMap(tw => toCandidates(tw, { handleToBrand, brands, stage: "keyword", matchedQuery: query })));
      log(`      ${b.name}: ${r.tweets.length} tweet(s) → ${candidates.length - before} mention(s)${r.truncated ? " [truncated]" : ""}`);
    }

    /* ------------------------------------------------------- stage 2: profiles */
    log("    stage 2/2 owned timelines");
    for (const b of allBrands()) {
      if (brands && !brands.includes(b.id)) continue;
      if (!b.x_handle) {
        gaps.push({ brand_id: b.id, reason: "No x_handle in config/brands.json — timeline not read." });
        continue;
      }
      stats.profile_queries++;
      const r = await paged(cursor =>
        `${BASE}/twitter/user/last_tweets?userName=${encodeURIComponent(b.x_handle)}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));

      if (r.error) {
        stats.errors.push(`${b.id} profile: ${r.error}`);
        log(`      @${b.x_handle}: ERROR ${r.error}`);
        continue;
      }
      if (r.truncated) stats.truncated.push(`${b.id} profile (${MAX_PAGES} pages)`);
      stats.tweets += r.tweets.length;
      const before = candidates.length;
      add(r.tweets.flatMap(tw => toCandidates(tw, { handleToBrand, brands, stage: "profile" })));
      log(`      @${b.x_handle}: ${r.tweets.length} tweet(s) → ${candidates.length - before} new mention(s)${r.truncated ? " [truncated]" : ""}`);
    }

    /* ------------------------------------------------------------ date window */
    const cutoff = new Date(Date.now() - sinceDays * 864e5);
    const inWindow = candidates.filter(c => {
      if (!c.published_at) return true;
      return new Date(c.published_at) >= cutoff;
    });
    stats.out_of_window = candidates.length - inWindow.length;

    /* ------------------------------------------------------------- gaps */
    const covered = new Set(inWindow.map(c => c.brand_id));
    for (const b of allBrands()) {
      if (covered.has(b.id)) continue;
      gaps.push({
        brand_id: b.id,
        reason:
          `No tweet naming ${b.name}, and nothing on @${b.x_handle || "(no handle)"}, within ` +
          `${sinceDays} days. Both a keyword search and the owned timeline were checked, so this is ` +
          `a measured absence for those two routes rather than an unqueried channel.`,
      });
    }
    if (stats.truncated.length) {
      gaps.push({
        brand_id: null,
        reason:
          `${stats.truncated.length} query(ies) hit the ${MAX_PAGES}-page cap, so those counts are a ` +
          `floor rather than a total: ${stats.truncated.slice(0, 5).join("; ")}.`,
      });
    }

    log(`    ${inWindow.length} candidate(s) from ${stats.tweets} tweet(s) ` +
      `(${stats.keyword_queries} keyword + ${stats.profile_queries} profile queries)` +
      `${stats.out_of_window ? `, ${stats.out_of_window} outside the ${sinceDays}d window` : ""}`);

    return { candidates: inWindow, gaps, providerStats: stats };
  },
};
