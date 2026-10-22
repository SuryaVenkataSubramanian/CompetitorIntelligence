/**
 * X keyword search: three actors, one normalised shape, tried in cost order.
 *
 * WHY A CHAIN RATHER THAN A FAVOURITE
 * -----------------------------------
 * Every open-source and commercial X scraper shares one documented failure
 * mode: it works until X rotates its GraphQL ids, then it returns nothing —
 * quietly. A single actor is therefore a single point of silent failure on the
 * one channel that has no keyless route at all. Three actors with the same
 * contract means a rotation costs one wasted call instead of the channel.
 *
 * THE ORDER IS BY MEASURED COST, AND THE SPREAD IS ENORMOUS
 * --------------------------------------------------------
 * Same query, same 5 tweets, same day:
 *
 *   simoit/x-twitter-search-tweets-scrapper   $0.0030   $0.0006/tweet    7.3s
 *   apidojo/tweet-scraper                     $0.0040   $0.0008/tweet   ~5s
 *   khadinakbar/x-tweet-scraper               $0.1161   $0.0232/tweet   40.9s
 *
 * khadinakbar is TWENTY-NINE TIMES the cost of simoit for identical results —
 * it bills compute, not results, and took 41 seconds to do what simoit did in
 * 7. A single seven-brand sweep through it at 20 tweets each would be ~$3.25,
 * roughly two-thirds of the entire $5 monthly plan. It is kept as a last
 * resort because a third route has value when the other two break, and it is
 * capped hard so it can never quietly eat the budget.
 *
 * ALL THREE RETURNED THE SAME TWEETS on the comparison query, so this ordering
 * costs nothing in coverage.
 */

/** Shared output shape. Every normaliser returns this or null. */
function shape({ id, url, text, handle, name, createdAt, likes, retweets, replies, views, followers }) {
  if (!text || !url) return null;
  return {
    id: id ? String(id) : null,
    url: String(url),
    text: String(text),
    handle: handle ? String(handle) : null,
    name: name ? String(name) : null,
    created_at: createdAt || null,
    likes: num(likes),
    retweets: num(retweets),
    replies: num(replies),
    views: num(views),
    author_followers: num(followers),
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Build a tweet URL when the actor gives an id and a handle but no link. */
function urlFrom(handle, id) {
  return handle && id ? `https://x.com/${handle}/status/${id}` : null;
}

const ACTORS = [
  {
    key: "x_simoit",
    id: "simoit~x-twitter-search-tweets-scrapper",
    label: "X search (simoit)",
    usd_per_item: 0.0006,
    /* `sort` is a lowercase enum — "latest", not "Latest". The wrong case
     * returns HTTP 400 and costs nothing, which is the good kind of failure. */
    input: (alias, max) => ({
      inputTargetType: "search",
      searchTerms: alias,
      maxItems: max,
      sort: "latest",
    }),
    normalise: t => shape({
      id: t.id_str || t.id,
      url: t.url || urlFrom(t.user && t.user.username, t.id_str || t.id),
      text: t.rawContent || t.text,
      handle: t.user && t.user.username,
      name: t.user && (t.user.displayname || t.user.name),
      createdAt: t.date,
      likes: t.likeCount,
      retweets: t.retweetCount,
      replies: t.replyCount,
      views: t.viewCount,
      followers: t.user && t.user.followersCount,
    }),
  },
  {
    key: "x_apidojo",
    id: "apidojo~tweet-scraper",
    label: "X search (apidojo)",
    usd_per_item: 0.0008,
    input: (alias, max) => ({ searchTerms: [alias], maxItems: max, sort: "Latest" }),
    normalise: t => shape({
      id: t.id,
      url: t.twitterUrl || t.url || urlFrom(t.author && t.author.userName, t.id),
      text: t.text || t.full_text,
      handle: t.author && t.author.userName,
      name: t.author && (t.author.name || t.author.userName),
      createdAt: t.createdAt || t.created_at,
      likes: t.likeCount,
      retweets: t.retweetCount,
      replies: t.replyCount,
      views: t.viewCount,
      followers: t.author && t.author.followers,
    }),
  },
  {
    key: "x_khadinakbar",
    id: "khadinakbar~x-tweet-scraper",
    label: "X search (khadinakbar)",
    // 29x the others. Priced on compute, so the per-item figure is a floor.
    usd_per_item: 0.0232,
    last_resort: true,
    input: (alias, max) => ({ searchQuery: alias, maxTweetsPerQuery: max, sort: "Latest" }),
    normalise: t => shape({
      id: t.tweet_id,
      url: t.url || t.tweet_url || urlFrom(t.author_handle, t.tweet_id),
      text: t.full_text || t.text,
      handle: t.author_handle,
      name: t.author_name,
      createdAt: t.created_at,
      likes: t.like_count,
      retweets: t.retweet_count,
      replies: t.reply_count,
      views: t.view_count,
      followers: t.author_followers,
    }),
  },
];

/**
 * Normalise an actor's raw dataset rows, dropping anything unusable.
 *
 * Sentinel filtering already happens in lib/apify.js, so what arrives here is
 * real rows; this only discards rows the normaliser cannot turn into a tweet
 * with both text and a URL.
 */
function normaliseAll(actor, items) {
  const out = [];
  for (const raw of items || []) {
    let t = null;
    try { t = actor.normalise(raw); } catch (e) { t = null; }
    if (t) out.push(t);
  }
  return out;
}

module.exports = { ACTORS, normaliseAll };
