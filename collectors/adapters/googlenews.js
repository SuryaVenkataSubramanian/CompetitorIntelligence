/**
 * Adapter: Google News RSS  →  channel "web"
 *
 * STATUS: DISCOVERY-ONLY, DEGRADES WITHOUT SEARXNG. Read this before trusting it.
 *
 * Measured on 2026-08-10, Google News RSS no longer exposes publisher URLs:
 *   <link>   https://news.google.com/rss/articles/CBMiVEFVX3lxTE1K...?oc=5
 *   <guid>   the same opaque token
 *   <description> an <a href> pointing at the same news.google.com token
 *   <source url="https://getlatka.com">GetLatka</source>   <-- only real signal
 *
 * Following that link returns a 578KB JS interstitial with no meta-refresh, no
 * data-n-au attribute and no plain external href. The token itself
 * ("CBMi" + a Google-signed AU_yqLMJ… blob) is not a decodable URL — base64
 * decoding yields opaque bytes, not a target.
 *
 * The previous version of this dashboard stored those news.google.com redirects
 * as mentions, which is why one shipped record had domain "news.google.com" and
 * a link a business user could not act on. This adapter refuses to do that.
 *
 * What it does instead: treats each item as a LEAD (publisher domain + exact
 * title + exact pubDate) and resolves the lead to a real article URL via
 * SearXNG (`site:<publisher> "<title>"`). If SearXNG is not running, the adapter
 * reports itself DEGRADED and contributes nothing rather than emitting links
 * that do not resolve to the article.
 */
const { fetchUrl, pool } = require("../lib/fetch");
const { parseFeed, domainOf, decodeEntities, norm } = require("../lib/verify");
const { allBrands, searchTerms } = require("../lib/brands");
const provider = require("../lib/serp-provider");

const GN_TOKEN = /news\.google\.com\/rss\/articles\//;

/** Extract <source url="..">Publisher</source> — the only real URL Google gives. */
function parseSources(xml) {
  const out = [];
  for (const b of String(xml).matchAll(/<item>[\s\S]*?<\/item>/g)) {
    const s = b[0];
    const src = s.match(/<source[^>]+url=["']([^"']+)["'][^>]*>([\s\S]*?)<\/source>/i);
    const guid = s.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
    out.push({
      publisher_url: src ? src[1] : null,
      publisher_name: src ? decodeEntities(src[2]).trim() : null,
      guid: guid ? guid[1].trim() : null,
    });
  }
  return out;
}

/**
 * Google appends " - Publisher" to titles. Strip it so the search query is the
 * article's real headline.
 */
function cleanTitle(title, publisherName) {
  let t = String(title || "").trim();
  if (publisherName) {
    const suffix = new RegExp("\\s*[-–|]\\s*" + publisherName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$", "i");
    t = t.replace(suffix, "");
  }
  return t.trim();
}

/** Resolve a (title, publisher domain) lead to the real article URL via SearXNG. */
async function resolveLead(title, publisherDomain, days) {
  const q = `site:${publisherDomain} "${title.slice(0, 90)}"`;
  const prov = await provider.resolve();
  const s = await prov.search(q, { days: Math.max(days, 365) });
  if (!s.ok || !s.results.length) return null;

  // Accept a hit only if its title genuinely corresponds to the lead, so we
  // never attach a real URL to the wrong article.
  const want = norm(title).slice(0, 60);
  for (const r of s.results) {
    if (!r.url || domainOf(r.url) !== publisherDomain) continue;
    const got = norm(r.title || "");
    if (got.includes(want.slice(0, 35)) || want.includes(got.slice(0, 35))) {
      return { url: r.url, matched_title: r.title };
    }
  }
  return null;
}

module.exports = {
  id: "googlenews",
  label: "Google News RSS (discovery → SearXNG resolution)",
  channel: "web",
  requires: ["a running SearXNG instance, to resolve leads to publisher URLs"],
  available() {
    return { ok: true, reason: null };
  },
  coverageLimit: {
    note:
      "Google News RSS exposes only opaque news.google.com tokens, not publisher URLs. " +
      "This source therefore requires SearXNG to resolve each lead to a real article link, " +
      "and contributes nothing when SearXNG is unavailable.",
  },

  async collect({ sinceDays = 90, log = () => {} } = {}) {
    const candidates = [];
    const gaps = [];

    const prov0 = await provider.resolve({ log });
    const probe = prov0.unavailable ? { ok: false, reason: prov0.note } : { ok: true };
    if (!probe.ok) {
      const reason =
        "Google News is discovery-only (it returns opaque news.google.com tokens, not article URLs) " +
        "and needs SearXNG to resolve leads. SearXNG unavailable: " + probe.reason;
      log(`    degraded: ${reason}`);
      return { candidates: [], gaps: [{ brand_id: null, reason }], unavailable: true };
    }

    const cutoff = new Date(Date.now() - sinceDays * 864e5);

    for (const b of allBrands()) {
      const q = encodeURIComponent(searchTerms(b.id)[0]);
      const feedUrl = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
      const r = await fetchUrl(feedUrl, { accept: "application/rss+xml,application/xml,*/*" });
      if (!r.ok) {
        gaps.push({ brand_id: b.id, reason: `Google News RSS HTTP ${r.status}` });
        continue;
      }

      const items = parseFeed(r.body);
      const sources = parseSources(r.body);
      const leads = items
        .map((it, i) => ({ ...it, ...(sources[i] || {}) }))
        .filter(it => !it.published || new Date(it.published) >= cutoff)
        .filter(it => it.publisher_url)
        .slice(0, 25);

      const outOfWindow = items.length - leads.length;

      const resolved = await pool(leads, 3, async lead => {
        const pubDomain = domainOf(lead.publisher_url);
        if (!pubDomain) return null;
        const title = cleanTitle(lead.title, lead.publisher_name);
        if (!title || title.length < 12) return null;
        // A token link is never stored; only a resolved publisher URL is.
        const hit = await resolveLead(title, pubDomain, sinceDays);
        return hit ? { lead, title, pubDomain, url: hit.url } : { lead, title, pubDomain, url: null };
      });

      let kept = 0;
      let unresolved = 0;
      for (const row of resolved) {
        if (!row) continue;
        if (!row.url) { unresolved++; continue; }
        if (GN_TOKEN.test(row.url)) { unresolved++; continue; } // belt and braces
        candidates.push({
          brand_id: b.id,
          channel: "web",
          url: row.url,
          title: row.title,
          published_at: row.lead.published || null,
          date_method: row.lead.published ? "rss:pubDate (Google News)" : null,
          source_text: null, // Google's description is just the token link
          source_verified: false,
          source_adapter: "googlenews",
          discovered_via: feedUrl,
          extra: {
            publisher: row.pubDomain,
            publisher_name: row.lead.publisher_name,
            link_resolution: "searxng site: + title match",
          },
        });
        kept++;
      }
      if (unresolved) {
        gaps.push({
          brand_id: b.id,
          reason:
            `${unresolved} Google News lead(s) could not be resolved to a publisher URL and were ` +
            `DROPPED rather than stored as unusable news.google.com redirect links.`,
        });
      }
      log(
        `    ${b.name}: ${kept} resolved of ${leads.length} leads` +
          `${outOfWindow ? `, ${outOfWindow} outside ${sinceDays}d` : ""}` +
          `${unresolved ? `, ${unresolved} dropped` : ""}`
      );
    }

    return { candidates, gaps };
  },
};
