/**
 * Adapter: GDELT DOC 2.0  →  channel "web"
 *
 * Free, no API key, monitors global news in 65 languages.
 * https://api.gdeltproject.org/api/v2/doc/doc
 *
 * Two constraints that materially affect the dashboard and are therefore
 * reported rather than absorbed:
 *   1. GDELT keeps a ~3-month ROLLING WINDOW. A 365-day range cannot be served
 *      by GDELT, so the 365d view is explicitly marked as partially covered.
 *   2. GDELT asks for no more than one request every 5 seconds. lib/fetch.js
 *      enforces a 5.5s gap for this host, so this adapter is slow by design.
 */
const { fetchJson } = require("../lib/fetch");
const { allBrands, searchTerms } = require("../lib/brands");
const { toIsoDate } = require("../lib/verify");

const MAX_WINDOW_DAYS = 90; // GDELT's rolling window

function timespanFor(days) {
  const d = Math.min(days, MAX_WINDOW_DAYS);
  if (d <= 1) return "1d";
  if (d <= 7) return "7d";
  if (d <= 31) return "1month";
  return "3months";
}

module.exports = {
  id: "gdelt",
  label: "GDELT global news",
  channel: "web",
  requires: [],
  available() {
    return { ok: true, reason: null };
  },
  coverageLimit: {
    max_days: MAX_WINDOW_DAYS,
    note: "GDELT DOC 2.0 serves a ~3-month rolling window; ranges beyond 90 days are not covered by this source.",
  },

  async collect({ sinceDays = 90, log = () => {} } = {}) {
    const candidates = [];
    const gaps = [];
    const timespan = timespanFor(sinceDays);

    if (sinceDays > MAX_WINDOW_DAYS) {
      gaps.push({
        brand_id: null,
        reason:
          `Requested ${sinceDays}d but GDELT only serves ~${MAX_WINDOW_DAYS}d. ` +
          `News coverage beyond ${MAX_WINDOW_DAYS} days comes from other adapters only.`,
      });
    }

    for (const b of allBrands()) {
      // Exact-phrase query on the primary alias keeps precision high.
      const query = searchTerms(b.id)[0];
      const url =
        "https://api.gdeltproject.org/api/v2/doc/doc?query=" +
        encodeURIComponent(query) +
        `&mode=ArtList&format=json&maxrecords=75&sort=DateDesc&timespan=${timespan}`;

      const r = await fetchJson(url);
      if (!r.ok || !r.json) {
        const why = r.parse_error
          ? `non-JSON response (${String(r.body).slice(0, 80).replace(/\s+/g, " ")})`
          : `HTTP ${r.status}`;
        gaps.push({ brand_id: b.id, reason: `GDELT: ${why}` });
        log(`    ${b.name}: GDELT ${why}`);
        continue;
      }
      const arts = Array.isArray(r.json.articles) ? r.json.articles : [];
      for (const a of arts) {
        if (!a.url) continue;
        candidates.push({
          brand_id: b.id,
          channel: "web",
          url: a.url,
          title: a.title || null,
          published_at: toIsoDate(a.seendate) || null,
          date_method: a.seendate ? "gdelt:seendate" : null,
          source_text: null, // GDELT gives no snippet; evidence comes from the page
          source_verified: false, // the article URL must prove itself
          source_adapter: "gdelt",
          discovered_via: url,
          extra: { gdelt_domain: a.domain || null, language: a.language || null },
        });
      }
      log(`    ${b.name}: ${arts.length} GDELT articles (${timespan})`);
    }

    return { candidates, gaps };
  },
};
