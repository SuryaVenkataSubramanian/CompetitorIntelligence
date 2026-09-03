/**
 * Adapter: YouTube channel RSS  →  channel "video"
 *
 * https://www.youtube.com/feeds/videos.xml?channel_id=UC... is free, needs no
 * API key and no quota, and returns exact publish timestamps. Limitation, stated
 * plainly because it affects the numbers: the feed serves only the ~15 most
 * recent uploads, so a 365-day window will under-report for channels that post
 * frequently. That shortfall is reported as a coverage note, not hidden.
 *
 * For Atlassian (a corporate channel covering many products) each video must
 * still pass Confluence mention confirmation, so unrelated uploads are excluded.
 */
const { fetchUrl } = require("../lib/fetch");
const { parseFeed } = require("../lib/verify");
const { allBrands } = require("../lib/brands");

const FEED_ITEM_CAP = 15; // what YouTube's RSS actually returns

module.exports = {
  id: "youtube",
  label: "YouTube channel RSS",
  channel: "video",
  requires: [],
  available() {
    return { ok: true, reason: null };
  },

  async collect({ sinceDays = 365, log = () => {} } = {}) {
    const cutoff = new Date(Date.now() - sinceDays * 864e5);
    const candidates = [];
    const gaps = [];

    for (const b of allBrands()) {
      if (!b.youtube_feed) {
        gaps.push({ brand_id: b.id, reason: b.youtube_note || "no YouTube channel resolved" });
        continue;
      }
      const r = await fetchUrl(b.youtube_feed, {
        accept: "application/atom+xml,application/xml,text/xml,*/*",
      });
      if (!r.ok) {
        gaps.push({ brand_id: b.id, reason: `channel feed returned HTTP ${r.status}` });
        continue;
      }
      const items = parseFeed(r.body);
      let kept = 0;
      let outOfWindow = 0;
      for (const it of items) {
        if (it.published && new Date(it.published) < cutoff) { outOfWindow++; continue; }
        candidates.push({
          brand_id: b.id,
          channel: "video",
          url: it.url,
          title: it.title,
          published_at: it.published || null,
          date_method: it.published ? "atom:published" : null,
          source_text: it.summary || null,
          source_verified: true,
          source_adapter: "youtube",
          discovered_via: b.youtube_feed,
          author: it.author || b.name,
          extra: { channel_id: b.youtube_channel_id, platform: "youtube" },
        });
        kept++;
      }
      // If the whole feed is inside the window, the 15-item cap may be truncating.
      const trunc = items.length >= FEED_ITEM_CAP && outOfWindow === 0;
      if (trunc) {
        gaps.push({
          brand_id: b.id,
          reason:
            `YouTube RSS returns only the ${FEED_ITEM_CAP} most recent uploads and all ${items.length} ` +
            `fall inside the ${sinceDays}d window — video counts for this brand are a floor, not a total.`,
        });
      }
      log(`    ${b.name}: ${kept} videos in window${trunc ? " (feed cap reached — undercount)" : ""}`);
    }

    return { candidates, gaps };
  },
};
