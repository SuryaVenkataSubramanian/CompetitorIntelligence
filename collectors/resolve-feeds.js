/**
 * Discovers per-brand feed endpoints by fetching them, so config/brands.json
 * contains only endpoints proven to exist. Nothing here is guessed: a candidate
 * that does not return a parseable feed is reported as unresolved and left null.
 *
 * Run: node collectors/resolve-feeds.js
 */
const { fetchUrl, pool } = require("./lib/fetch");
const { parseFeed } = require("./lib/verify");

// `yt` entries may be a handle ("@gitbookIO"), a /channel/ id, or a /c//user/ path.
// Channel ids found by search are still PROVEN below by fetching their RSS feed.
const BRANDS = [
  { id: "document360", name: "Document360", domain: "document360.com",
    yt: ["@document360", "channel/UCSTM-T1Ephlh4utlz2l27Jg"],
    extraFeeds: ["https://document360.com/blog/feed"] },
  { id: "mintlify", name: "Mintlify", domain: "mintlify.com",
    yt: ["channel/UC0LsSxHB7zaKHcN6tiNYiFQ", "@mintlify"],
    extraFeeds: ["https://mintlify.com/feed.xml", "https://mintlify.com/blog/feed.xml"] },
  { id: "gitbook", name: "GitBook", domain: "gitbook.com",
    yt: ["@gitbookIO", "@GitBook"],
    extraFeeds: ["https://www.gitbook.com/blog/rss.xml", "https://gitbook.com/blog/rss.xml",
                 "https://www.gitbook.com/blog/feed", "https://www.gitbook.com/blog/feeds/rss",
                 "https://gitbook.com/docs/changelog/feed"] },
  { id: "confluence", name: "Confluence", domain: "atlassian.com",
    yt: ["@Atlassian", "channel/UCmM5yxBJKu-JMJ3Js2wE6vw"],
    extraFeeds: ["https://www.atlassian.com/blog/feed", "https://www.atlassian.com/blog/rss.xml",
                 "https://confluence.atlassian.com/display/DOC/blog/rss"] },
  { id: "guru", name: "Guru", domain: "getguru.com",
    yt: ["@guru_hq", "@getguru", "@GuruHQ", "@Guru"],
    extraFeeds: ["https://www.getguru.com/blog/rss.xml", "https://www.getguru.com/rss.xml",
                 "https://www.getguru.com/blog/feed", "https://www.getguru.com/feed"] },
  { id: "bloomfire", name: "Bloomfire", domain: "bloomfire.com",
    yt: ["@Bloomfire", "channel/UCMM30a-zh0zRYdzvCsCo6Qw"],
    extraFeeds: ["https://bloomfire.com/blog/feed"] },
  { id: "knowledgeowl", name: "KnowledgeOwl", domain: "knowledgeowl.com",
    yt: ["@KnowledgeOwl", "@knowledgeowl", "@KnowledgeOwlKB"],
    extraFeeds: ["https://www.knowledgeowl.com/blog/rss.xml", "https://www.knowledgeowl.com/home/rss.xml",
                 "https://knowledgeowl.com/blog/feed", "https://www.knowledgeowl.com/blog/feed",
                 "https://support.knowledgeowl.com/help/rss.xml"] },
];

// Common blog/changelog feed locations, tried in order.
const FEED_PATHS = [
  "/blog/rss.xml", "/blog/feed", "/blog/feed.xml", "/blog/rss", "/blog/index.xml",
  "/feed", "/rss.xml", "/feed.xml", "/index.xml", "/rss",
  "/blog/atom.xml", "/atom.xml", "/changelog.xml", "/blog/rss/",
];

// A comments feed is not a content feed — accepting one would silently fill the
// Blogs channel with reader comments instead of the brand's posts.
const REJECT_FEED = /\/comments\/|\/comment\/|comments\.rss|\/replies/i;

function looksLikeFeed(receipt) {
  if (!receipt.ok || !receipt.body) return false;
  if (REJECT_FEED.test(receipt.final_url || receipt.url || "")) return false;
  const head = receipt.body.slice(0, 2000).toLowerCase();
  if (!/<rss|<feed|<rdf:rdf/.test(head)) return false;
  return parseFeed(receipt.body).length > 0;
}

/** Look for <link rel="alternate" type="application/rss+xml"> on the homepage. */
async function discoverFromHtml(domain) {
  const out = [];
  for (const base of [`https://${domain}/blog`, `https://${domain}`]) {
    const r = await fetchUrl(base);
    if (!r.ok || !r.body) continue;
    const links = [
      ...r.body.matchAll(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi),
    ].map(m => m[0]);
    for (const tag of links) {
      const href = tag.match(/href=["']([^"']+)["']/i);
      if (!href) continue;
      try {
        out.push(new URL(href[1], base).toString());
      } catch (e) { /* ignore malformed href */ }
    }
    if (out.length) break;
  }
  return [...new Set(out)];
}

async function resolveBlogFeed(brand) {
  // 1. Explicit candidates first (found via search, still proven by fetching).
  for (const url of brand.extraFeeds || []) {
    const r = await fetchUrl(url, { accept: "application/rss+xml,application/xml,text/xml,*/*", retries: 0 });
    if (looksLikeFeed(r)) {
      const items = parseFeed(r.body);
      return { url, items: items.length, dated: items.filter(i => i.published).length, how: "explicit candidate" };
    }
  }
  // 2. Declared feeds in the page head.
  const declared = await discoverFromHtml(brand.domain);
  for (const url of declared) {
    if (REJECT_FEED.test(url)) continue;
    const r = await fetchUrl(url, { accept: "application/rss+xml,application/xml,text/xml,*/*" });
    if (looksLikeFeed(r)) {
      const items = parseFeed(r.body);
      return { url, items: items.length, dated: items.filter(i => i.published).length, how: "declared in <head>" };
    }
  }
  // 3. Otherwise probe conventional paths.
  const candidates = FEED_PATHS.map(p => `https://${brand.domain}${p}`);
  const results = await pool(candidates, 3, async url => {
    const r = await fetchUrl(url, { accept: "application/rss+xml,application/xml,text/xml,*/*", retries: 0 });
    return looksLikeFeed(r) ? { url, body: r.body } : null;
  });
  for (const hit of results) {
    if (hit && hit.url) {
      const items = parseFeed(hit.body);
      return { url: hit.url, items: items.length, dated: items.filter(i => i.published).length, how: "probed path" };
    }
  }
  return null;
}

/** Resolve a YouTube handle or channel path to its channel_id, then prove the feed. */
async function resolveYouTube(brand) {
  for (const handle of brand.yt) {
    let channelId = null;

    // A "channel/UC..." entry already carries the id; still proven by RSS below.
    const direct = handle.match(/^channel\/(UC[\w-]{20,})$/);
    if (direct) {
      channelId = direct[1];
    } else {
      const r = await fetchUrl(`https://www.youtube.com/${handle}`);
      if (!r.ok || !r.body) continue;
      const m =
        r.body.match(/"channelId":"(UC[\w-]{20,})"/) ||
        r.body.match(/channel_id=(UC[\w-]{20,})/) ||
        r.body.match(/"externalId":"(UC[\w-]{20,})"/);
      if (!m) continue;
      channelId = m[1];
    }
    // Prove the RSS feed actually serves videos for this id.
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const f = await fetchUrl(feedUrl, { accept: "application/atom+xml,application/xml,*/*" });
    if (looksLikeFeed(f)) {
      const items = parseFeed(f.body);
      return {
        handle,
        channel_id: channelId,
        feed: feedUrl,
        items: items.length,
        dated: items.filter(i => i.published).length,
        latest: items.map(i => i.published).filter(Boolean).sort().reverse()[0] || null,
      };
    }
  }
  return null;
}

(async () => {
  console.log("Resolving real feed endpoints (nothing is assumed — each is fetched)\n");
  const out = {};
  for (const b of BRANDS) {
    process.stdout.write(`${b.name.padEnd(14)} `);
    const [blog, yt] = [await resolveBlogFeed(b), await resolveYouTube(b)];
    out[b.id] = { blog_feed: blog, youtube: yt };
    const bl = blog ? `blog=OK ${blog.items} items (${blog.dated} dated)` : "blog=UNRESOLVED";
    const y = yt ? `yt=${yt.channel_id} ${yt.items} videos` : "yt=UNRESOLVED";
    console.log(`${bl.padEnd(40)} ${y}`);
    if (blog) console.log(`${" ".repeat(15)}${blog.url}  [${blog.how}]`);
    if (yt) console.log(`${" ".repeat(15)}${yt.feed}  latest=${yt.latest}`);
  }
  require("fs").writeFileSync(
    require("path").join(__dirname, "store", "resolved-feeds.json"),
    JSON.stringify({ resolved_at: new Date().toISOString(), brands: out }, null, 2)
  );
  console.log("\nWrote collectors/store/resolved-feeds.json");
})();
