/**
 * Apify actor output -> candidates for the shared verification pipeline.
 *
 * Nothing here decides what is true. It maps an actor's payload into the same
 * candidate shape every other source produces, and lib/pipeline.js then applies
 * the identical rules: the alias must appear in the text, the date must be
 * provable, the link must resolve. A paid source gets no shortcut — that is the
 * point of having one pipeline.
 */
const { brand, brandOrder } = require("./brands");
const { toIsoDate, decodeEntities } = require("./verify");
const { firstAliasIn } = require("./freshsources");
const apify = require("./apify");

/* --------------------------------------------------------------------- X */

/**
 * X via apidojo/tweet-scraper.
 *
 * MEASURED: 5 tweets for "Document360" cost $0.0020 and included a genuine
 * third-party recommendation ("Document360 might be a good alternate to check
 * out. Their search works best.") dated the same day. twitterapi.io — the
 * previous route — is at -518 credits and answers 402 on every call, so this is
 * the only working route to X.
 */
async function sweepX({ brands, sinceMs, maxPerBrand = 20, log = () => {} }) {
  const candidates = [];
  const gaps = [];
  const { ACTORS: X_ACTORS, normaliseAll } = require("./apify-x-actors");

  for (const id of brands) {
    const b = brand(id);
    const alias = b.aliases[0];

    /* TRY EACH ACTOR UNTIL ONE ANSWERS, cheapest first.
     *
     * Every X scraper breaks when X rotates its GraphQL ids, and it breaks
     * SILENTLY - an empty result set, not an error. One actor is therefore a
     * single point of quiet failure on the only channel with no keyless route.
     * A chain turns a rotation into one wasted call. */
    let tweets = [];
    let usedActor = null;
    let lastReason = null;

    for (const actor of X_ACTORS) {
      // khadinakbar is 29x the cost of simoit for identical output, so it is
      // reached only when the cheap routes have actually failed - never as a
      // top-up when they merely returned few results.
      if (actor.last_resort && (usedActor || tweets.length)) break;

      const cap = actor.last_resort ? Math.min(maxPerBrand, 10) : maxPerBrand;
      const r = await apify.runActor(actor.key, actor.input(alias, cap), { maxItems: cap, log });

      if (!r.ok) {
        lastReason = r.reason;
        // A budget stop is account-wide: the next actor would refuse too.
        if (r.budget_stop || r.skipped === "not_configured") { tweets = []; usedActor = null; break; }
        continue;
      }
      const norm = normaliseAll(actor, r.items);
      if (norm.length) { tweets = norm; usedActor = actor; break; }
      // A genuine empty result is an answer, not a failure - record it and
      // stop, rather than paying a second actor to confirm a real zero.
      if (r.empty_result) { usedActor = actor; break; }
    }

    if (!usedActor) {
      if (lastReason) gaps.push({ brand_id: id, reason: lastReason, budget_stop: /budget/i.test(String(lastReason)) });
      if (lastReason && /budget|not configured/i.test(String(lastReason))) break;
      continue;
    }

    let kept = 0;
    for (const t of tweets) {
      const text = decodeEntities(t.text);
      const matched = firstAliasIn(text, id);
      if (!matched) continue;

      const published = toIsoDate(t.created_at);
      if (published && sinceMs && Date.parse(published) < sinceMs) continue;

      candidates.push({
        brand_id: id,
        channel: "x",
        url: t.url,
        title: null,
        published_at: published,
        date_method: published ? `apify:${usedActor.key} created_at` : null,
        source_text: text,
        source_verified: true,
        source_adapter: "x_apify",
        discovered_via: `apify:${usedActor.id} "${alias}"`,
        author: t.name || t.handle || null,
        extra: {
          matched_alias: matched,
          author_handle: t.handle,
          author_followers: t.author_followers,
          likes: t.likes,
          retweets: t.retweets,
          replies: t.replies,
          views: t.views,
          paid_source: "apify",
          // Which actor actually served this, so a shift in the chain is
          // visible in the data rather than only in a log.
          actor: usedActor.key,
        },
      });
      kept++;
    }
    log(`      apify x: ${b.name} — ${kept} tweet(s) via ${usedActor.label}`);
  }

  return { candidates, gaps };
}

/* -------------------------------------------------------------- LinkedIn */

/**
 * LinkedIn via harvestapi/linkedin-post-search.
 *
 * A STRICT UPGRADE ON THE SERPAPI ROUTE, measured on the same brand:
 *
 *   SerpAPI site: query   finds posts, but Google's snippet carries NO DATE and
 *                         no author. 19 of 38 authors had to be recovered by
 *                         regex from page text; the rest stayed "unknown", and
 *                         every record was undated.
 *   this                  exact ISO timestamps (2026-09-29T14:02:37) and real
 *                         author names on every post, plus the full post body
 *                         rather than a truncated snippet.
 *
 * `postedLimit` takes an enum — "week", not "past-week". The wrong value
 * returns HTTP 400 and costs nothing, which is the good kind of failure.
 */
async function sweepLinkedIn({ brands, sinceMs, maxPerBrand = 10, log = () => {} }) {
  const candidates = [];
  const gaps = [];

  for (const id of brands) {
    const b = brand(id);
    const alias = b.aliases[0];

    const r = await apify.runActor("linkedin", {
      searchQueries: [alias],
      maxPosts: maxPerBrand,
      postedLimit: "week",
    }, { maxItems: maxPerBrand, log });

    if (!r.ok) {
      gaps.push({ brand_id: id, reason: r.reason, budget_stop: !!r.budget_stop });
      if (r.budget_stop || r.skipped === "not_configured") break;
      continue;
    }

    let kept = 0;
    for (const p of r.items) {
      const text = decodeEntities(p.content || p.text || "");
      const url = p.linkedinUrl || p.url || p.postUrl;
      if (!text || !url) continue;

      const matched = firstAliasIn(text, id);
      if (!matched) continue;

      const rawDate = (p.postedAt && (p.postedAt.date || p.postedAt.timestamp)) || p.postedAt || null;
      const published = toIsoDate(rawDate);
      if (published && sinceMs && Date.parse(published) < sinceMs) continue;

      candidates.push({
        brand_id: id,
        channel: "linkedin",
        url,
        title: null,
        published_at: published,
        date_method: published ? "apify:linkedin postedAt" : null,
        source_text: text,
        source_verified: true,
        source_adapter: "linkedin_apify",
        discovered_via: `apify:${apify.ACTORS.linkedin.id} "${alias}"`,
        author: (p.author && (p.author.name || p.author.publicIdentifier)) || null,
        extra: {
          matched_alias: matched,
          author_headline: (p.author && p.author.headline) || null,
          author_url: (p.author && p.author.linkedinUrl) || null,
          reactions: p.engagement ? (p.engagement.likes ?? p.engagement.reactions ?? null) : null,
          comments: p.engagement ? (p.engagement.comments ?? null) : null,
          paid_source: "apify",
        },
      });
      kept++;
    }
    log(`      apify linkedin: ${b.name} — ${kept} post(s)`);
  }

  return { candidates, gaps };
}

/**
 * Both channels, paced and budget-guarded as one unit.
 *
 * Paced together rather than per-channel: the budget is one account balance, so
 * two independently-paced sweeps would drain it twice as fast while each
 * believed it was being careful.
 */
async function sweep({ brands = null, sinceMs = null, force = false, log = () => {} } = {}) {
  const out = { candidates: [], gaps: [], ran: false, reason: null, throttled: false };

  const cred = apify.credentialStatus();
  if (!cred.ok) { out.reason = cred.reason; return out; }

  const pace = apify.pacing({ force });
  if (!pace.ok) {
    out.throttled = true;
    out.reason = pace.reason;
    log(`      apify: ${pace.reason}`);
    return out;
  }

  const ids = brands && brands.length ? brands.filter(x => brandOrder().includes(x)) : brandOrder();

  const x = await sweepX({ brands: ids, sinceMs, log });
  out.candidates.push(...x.candidates);
  out.gaps.push(...x.gaps);

  /* LINKEDIN IS NO LONGER ROUTED THROUGH APIFY.
   *
   * It was bought for exact dates and real author names, which the free
   * SerpAPI route could not supply. lib/linkedin-public.js now reads both
   * straight off LinkedIn's own authwalled page, keyless — MEASURED 20/20 on
   * date, author and body text across 20 posts.
   *
   * Paying $0.0020 a post for data the page gives away is not a trade worth
   * making, and the saving goes to X, where no keyless route to keyword search
   * exists at any price. sweepLinkedIn is kept and exported so the comparison
   * can be re-run, but it is not called. */
  const li = { candidates: [], gaps: [] };

  apify.markSweep();
  out.ran = true;
  return out;
}

module.exports = { sweep, sweepX, sweepLinkedIn };
