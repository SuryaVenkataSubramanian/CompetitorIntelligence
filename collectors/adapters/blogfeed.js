/**
 * Adapter: brand-owned blog / changelog RSS feeds  →  channel "blog"
 *
 * Highest-quality source available without any credential: first-party, exact
 * publication dates, and no rate limiting. Feeds were proven to exist by
 * collectors/resolve-feeds.js; brands with no feed are reported as a coverage
 * gap rather than silently contributing zero.
 */
const { fetchUrl } = require("../lib/fetch");
const { parseFeed } = require("../lib/verify");
const { allBrands } = require("../lib/brands");

module.exports = {
  id: "blogfeed",
  label: "Brand blog/changelog RSS",
  channel: "blog",
  requires: [],
  available() {
    return { ok: true, reason: null };
  },

  async collect({ sinceDays = 365, log = () => {} } = {}) {
    const cutoff = new Date(Date.now() - sinceDays * 864e5);
    const candidates = [];
    const gaps = [];

    for (const b of allBrands()) {
      if (!b.blog_feed) {
        gaps.push({ brand_id: b.id, reason: b.blog_feed_note || "no RSS feed resolved" });
        continue;
      }
      const r = await fetchUrl(b.blog_feed, {
        accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*",
      });
      if (!r.ok) {
        gaps.push({ brand_id: b.id, reason: `feed returned HTTP ${r.status}` });
        log(`    ${b.name}: feed HTTP ${r.status}`);
        continue;
      }
      const items = parseFeed(r.body);
      let kept = 0;
      for (const it of items) {
        // A feed item with no date is not date-usable; keep it but the pipeline
        // will mark date_confidence "unknown".
        if (it.published && new Date(it.published) < cutoff) continue;
        candidates.push({
          brand_id: b.id,
          channel: "blog",
          url: it.url,
          title: it.title,
          published_at: it.published || null,
          date_method: it.published ? "rss:pubDate" : null,
          source_text: it.summary || null,
          source_verified: true, // the first-party feed itself returned 2xx
          source_adapter: "blogfeed",
          discovered_via: b.blog_feed,
          author: it.author || null,
        });
        kept++;
      }
      log(`    ${b.name}: ${kept} items within ${sinceDays}d of ${items.length} in feed`);
    }

    return { candidates, gaps };
  },
};
