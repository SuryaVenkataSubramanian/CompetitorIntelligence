/**
 * Adapter: Hacker News via Algolia  →  channel "web"
 *
 * Free, no key, exact ISO timestamps, and full historical range (no rolling
 * window), which makes it the only social-adjacent source that can actually
 * serve a 365-day window without credentials.
 *
 * Verified working against hn.algolia.com during build.
 */
const { fetchJson } = require("../lib/fetch");
const { allBrands, searchTerms } = require("../lib/brands");
const { toIsoDate } = require("../lib/verify");

module.exports = {
  id: "hackernews",
  label: "Hacker News (Algolia)",
  channel: "web",
  requires: [],
  available() {
    return { ok: true, reason: null };
  },

  async collect({ sinceDays = 365, log = () => {} } = {}) {
    const candidates = [];
    const gaps = [];
    const cutoffTs = Math.floor((Date.now() - sinceDays * 864e5) / 1000);

    for (const b of allBrands()) {
      const term = searchTerms(b.id)[0].replace(/"/g, "");
      // numericFilters keeps the window server-side; tags=(story,comment) covers both.
      const url =
        "https://hn.algolia.com/api/v1/search?query=" +
        encodeURIComponent(term) +
        `&tags=(story,comment)&hitsPerPage=50&numericFilters=created_at_i>${cutoffTs}`;

      const r = await fetchJson(url);
      if (!r.ok || !r.json) {
        gaps.push({ brand_id: b.id, reason: `Hacker News API HTTP ${r.status}` });
        continue;
      }
      const hits = r.json.hits || [];
      let kept = 0;
      for (const h of hits) {
        // A story's own URL is the mention target; a comment's target is the HN thread.
        const target = h.url || (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : null);
        if (!target) continue;
        const text = [h.title, h.story_title, h.comment_text].filter(Boolean).join(". ");
        candidates.push({
          brand_id: b.id,
          channel: "web",
          url: target,
          title: h.title || h.story_title || null,
          published_at: toIsoDate(h.created_at),
          date_method: "hn:created_at",
          source_text: text || null,
          // The Algolia API itself is authoritative that this post exists.
          source_verified: true,
          source_adapter: "hackernews",
          discovered_via: url,
          author: h.author || null,
          extra: {
            hn_object_id: h.objectID,
            hn_points: h.points ?? null,
            hn_num_comments: h.num_comments ?? null,
            hn_thread: `https://news.ycombinator.com/item?id=${h.story_id || h.objectID}`,
            is_comment: !!h.comment_text,
          },
        });
        kept++;
      }
      log(`    ${b.name}: ${kept} HN hits`);
    }

    return { candidates, gaps };
  },
};
