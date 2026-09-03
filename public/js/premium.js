/* ==========================================================================
   Premium mention card — platform identity, product highlighting, provenance.

   Modelled on the reference: a branded platform mark, a "Mention of X in Y"
   header, relative time, author with reach, the body with the PRODUCT NAME
   highlighted, the provider's own relevance note, then sentiment and tags.

   Two deliberate decisions:

   1. PLATFORM vs CHANNEL are shown separately. The filter model groups Reddit,
      GitHub, Hacker News and forums under "Web" — that grouping is what the
      matrix and filters need. But a card that says "on Web" throws away the
      thing a reader actually wants to know. So the card shows the real platform
      (Reddit, GitHub, …) derived from the URL, while the channel grouping stays
      intact underneath for filtering.

   2. The brand colour system is untouched. Platform marks use each platform's own
      brand colour because that is what makes them recognisable at a glance;
      everything else — accents, highlights, sentiment — keeps the existing
      Document360 purple and pos/neg/neu tokens.
   ========================================================================== */

/* ---------------------------------------------------------------- platforms */

/**
 * Specific platform for a mention, with its own mark and brand colour.
 * Derived from the URL (most reliable) with the provider's own source label as a
 * fallback, so a Reddit thread reads as Reddit even though it is filed under Web.
 */
const PLATFORMS = {
  reddit:      { label: "Reddit",       color: "#FF4500" },
  x:           { label: "X",            color: "#0F1419" },
  linkedin:    { label: "LinkedIn",     color: "#0A66C2" },
  youtube:     { label: "YouTube",      color: "#FF0000" },
  instagram:   { label: "Instagram",    color: "#E1306C" },
  facebook:    { label: "Facebook",     color: "#1877F2" },
  github:      { label: "GitHub",       color: "#24292F" },
  hackernews:  { label: "Hacker News",  color: "#FF6600" },
  stackoverflow: { label: "Stack Overflow", color: "#F48024" },
  devto:       { label: "DEV",          color: "#0A0A0A" },
  producthunt: { label: "Product Hunt", color: "#DA552F" },
  medium:      { label: "Medium",       color: "#000000" },
  g2:          { label: "G2",           color: "#FF492C" },
  capterra:    { label: "Capterra",     color: "#FF9D28" },
  podcast:     { label: "Podcast",      color: "#8E44AD" },
  web:         { label: "Web",          color: "#7C7B92" },
  blog:        { label: "Blog",         color: "#904DFF" },
  event:       { label: "Event",        color: "#E8A317" },
};

const PLATFORM_PATHS = {
  reddit: '<circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M17.6 12.1a1.3 1.3 0 0 0-2.2-.9 6.5 6.5 0 0 0-3.3-1l.7-3.2 2.2.5a.95.95 0 1 0 .1-.6l-2.6-.55a.3.3 0 0 0-.36.23l-.8 3.6a6.6 6.6 0 0 0-3.35 1 1.3 1.3 0 1 0-1.44 2.1 2.4 2.4 0 0 0-.03.4c0 2.05 2.4 3.7 5.35 3.7s5.35-1.65 5.35-3.7a2.4 2.4 0 0 0-.03-.4 1.3 1.3 0 0 0 .4-1.18z" fill="#fff"/><circle cx="9.6" cy="13.2" r="1.05" fill="'+"#FF4500"+'"/><circle cx="14.4" cy="13.2" r="1.05" fill="'+"#FF4500"+'"/><path d="M14.5 15.6a3.6 3.6 0 0 1-2.5.8 3.6 3.6 0 0 1-2.5-.8" stroke="#FF4500" stroke-width="0.9" stroke-linecap="round" fill="none"/>',
  x: '<path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.63l-5.2-6.8-5.94 6.8H1.73l7.5-8.58L1.08 2.25h6.8l4.71 6.23zm-1.16 17.52h1.83L5.9 4.13H3.94z" fill="currentColor"/>',
  linkedin: '<path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9h4v12H3zM10 9h3.8v1.7c.5-1 1.8-2 3.7-2 2.7 0 4.5 1.7 4.5 5.3V21h-4v-6.2c0-1.6-.6-2.6-2-2.6-1.2 0-1.9.8-2.2 1.6-.1.3-.1.7-.1 1V21h-4z" fill="currentColor"/>',
  youtube: '<path d="M23 12s0-3.5-.45-5.17a2.6 2.6 0 0 0-1.84-1.85C19.05 4.5 12 4.5 12 4.5s-7.05 0-8.71.48A2.6 2.6 0 0 0 1.45 6.83C1 8.5 1 12 1 12s0 3.5.45 5.17a2.6 2.6 0 0 0 1.84 1.85C4.95 19.5 12 19.5 12 19.5s7.05 0 8.71-.48a2.6 2.6 0 0 0 1.84-1.85C23 15.5 23 12 23 12z" fill="currentColor"/><path d="M9.75 15.02V8.98L15.5 12z" fill="#fff"/>',
  instagram: '<rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="currentColor"/><circle cx="12" cy="12" r="4.6" fill="none" stroke="#fff" stroke-width="1.9"/><circle cx="17.6" cy="6.5" r="1.25" fill="#fff"/>',
  facebook: '<circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M13.2 18.5v-5.6h1.95l.3-2.3h-2.25V9.1c0-.66.18-1.11 1.13-1.11h1.2V5.93c-.21-.03-.94-.09-1.79-.09-1.77 0-2.98 1.08-2.98 3.06v1.7H8.8v2.3h1.96v5.6z" fill="#fff"/>',
  github: '<path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.1-1.47-1.1-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.85-2.34 4.7-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .26.18.58.69.48A10 10 0 0 0 12 2z" fill="currentColor"/>',
  hackernews: '<rect x="2.5" y="2.5" width="19" height="19" rx="2" fill="currentColor"/><path d="M8 7h1.9l2.1 4.1L14.1 7H16l-3.1 5.9V17h-1.8v-4.1z" fill="#fff"/>',
  stackoverflow: '<path d="M17.6 20.2v-4.3h1.8V22H4.6v-6.1h1.8v4.3z" fill="currentColor"/><path d="M8.1 15.2l8.6 1.8.4-1.8-8.6-1.8zm1.1-4.2l8 3.7.8-1.7-8-3.7zm2.2-4l6.8 5.6 1.2-1.4-6.8-5.7zM15.7 2l-1.5 1.1 5.3 7.1 1.5-1.1zM7.9 18.4h8.8v-1.8H7.9z" fill="currentColor"/>',
  devto: '<rect x="2" y="4" width="20" height="16" rx="3" fill="currentColor"/><text x="12" y="15.5" font-size="7" font-weight="700" fill="#fff" text-anchor="middle" font-family="system-ui">DEV</text>',
  producthunt: '<circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M10 7.5h3.2a2.9 2.9 0 0 1 0 5.8H11.7V17H10zm1.7 4.2h1.5a1.3 1.3 0 0 0 0-2.6h-1.5z" fill="#fff"/>',
  medium: '<circle cx="6.2" cy="12" r="4.2" fill="currentColor"/><ellipse cx="14.2" cy="12" rx="2.3" ry="3.9" fill="currentColor"/><ellipse cx="20" cy="12" rx="1" ry="3.4" fill="currentColor"/>',
  g2: '<circle cx="12" cy="12" r="10" fill="currentColor"/><text x="12" y="16" font-size="9" font-weight="700" fill="#fff" text-anchor="middle" font-family="system-ui">G2</text>',
  capterra: '<path d="M2 6h20l-10 6z" fill="currentColor"/><path d="M2 6v12l10-6z" fill="currentColor" opacity=".7"/><path d="M12 12l10-6v12z" fill="currentColor" opacity=".85"/>',
  podcast: '<rect x="9.5" y="3" width="5" height="11" rx="2.5" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 18v3" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round"/>',
  blog: '<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="5" cy="19" r="1.8" fill="currentColor"/>',
  event: '<rect x="3" y="5" width="18" height="16" rx="2.5" fill="currentColor"/><path d="M8 3v4M16 3v4M3 11h18" stroke="#fff" stroke-width="1.7" fill="none" stroke-linecap="round"/>',
  web: '<circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M2.8 12h18.4M12 2.8a15 15 0 0 1 0 18.4 15 15 0 0 1 0-18.4z" fill="none" stroke="currentColor" stroke-width="1.7"/>',
};

/** Resolve the specific platform for a mention. URL first, provider label second. */
function platformOf(m) {
  const host = (() => {
    try { return new URL(m.url).hostname.replace(/^www\./, "").toLowerCase(); }
    catch (e) { return ""; }
  })();

  if (/(^|\.)reddit\.com$/.test(host)) return "reddit";
  if (/(^|\.)(x|twitter)\.com$/.test(host)) return "x";
  if (/(^|\.)linkedin\.com$/.test(host)) return "linkedin";
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return "youtube";
  if (/(^|\.)instagram\.com$/.test(host)) return "instagram";
  if (/(^|\.)(facebook\.com|fb\.com)$/.test(host)) return "facebook";
  if (/(^|\.)github\.(com|io)$/.test(host)) return "github";
  if (/(^|\.)ycombinator\.com$/.test(host)) return "hackernews";
  if (/(^|\.)stackoverflow\.com$/.test(host)) return "stackoverflow";
  if (/(^|\.)dev\.to$/.test(host)) return "devto";
  if (/(^|\.)producthunt\.com$/.test(host)) return "producthunt";
  if (/(^|\.)medium\.com$/.test(host)) return "medium";
  if (/(^|\.)g2\.com$/.test(host)) return "g2";
  if (/(^|\.)capterra\.com$/.test(host)) return "capterra";
  if (/(^|\.)(apple\.com\/.*podcast|podcasts\.apple\.com|spotify\.com)$/.test(host)) return "podcast";

  const provider = String((m.extra && m.extra.octolens_source) || "").toLowerCase();
  if (PLATFORMS[provider]) return provider;
  if (provider === "twitter") return "x";
  if (provider === "hacker news" || provider === "hn") return "hackernews";

  if (m.channel === "event") return "event";
  if (m.channel === "blog") return "blog";
  return "web";
}

function platformMark(pid, size = 20) {
  const p = PLATFORMS[pid] || PLATFORMS.web;
  return `<span class="pmark" style="color:${p.color}" title="${escP(p.label)}">
    <svg width="${size}" height="${size}" viewBox="0 0 24 24">${PLATFORM_PATHS[pid] || PLATFORM_PATHS.web}</svg>
  </span>`;
}

/* ------------------------------------------------------------ text helpers */

function escP(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * Escape first, THEN wrap brand aliases in <mark>. Doing it in this order means
 * the highlight can never be used to inject markup through a mention body.
 */
function highlightBrand(text, brandId, aliases) {
  let out = escP(text);
  const list = (aliases || []).slice().sort((a, b) => b.length - a.length);
  for (const alias of list) {
    const safe = escP(alias).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Word-boundary-ish so "Guru" does not highlight inside "gurus".
    out = out.replace(
      new RegExp(`(^|[^A-Za-z0-9>])(${safe})(?![A-Za-z0-9])`, "gi"),
      (mm, pre, hit) => `${pre}<mark class="bmark">${hit}</mark>`
    );
  }
  return out;
}

/** "5 hours ago" / "10 mins ago" — matches the reference's recency framing. */
function relTime(iso) {
  if (!iso) return null;
  const then = new Date(iso.length <= 10 ? iso + "T12:00:00Z" : iso);
  if (isNaN(then)) return null;
  const secs = Math.floor((Date.now() - then.getTime()) / 1000);
  if (secs < 0) return "just now";
  const units = [
    [31536000, "year"], [2592000, "month"], [604800, "week"],
    [86400, "day"], [3600, "hour"], [60, "min"],
  ];
  for (const [s, label] of units) {
    if (secs >= s) {
      const n = Math.floor(secs / s);
      return `${n} ${label}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

function compactNum(n) {
  if (n == null) return null;
  n = Number(n);
  if (!isFinite(n)) return null;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K";
  return String(n);
}

/** Provider tags render as-is (Title Case) so the provider's own labels show through. */
function prettyTag(t) {
  return String(t).replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

const SENT_FACE = { positive: "☺", negative: "☹", neutral: "◔" };

/* ------------------------------------------------------------- the card */

/**
 * Premium mention card.
 *
 * Reads as: [platform mark] Mention of PRODUCT in PLATFORM · when · author (reach)
 * then the body with the PRODUCT NAME highlighted, the provider's own relevance
 * note, and finally sentiment + tags.
 *
 * The product name is highlighted because the entire job of a mention feed is
 * "where does my brand appear in this text" — making the reader hunt for it is
 * work the dashboard should be doing for them.
 *
 * Provenance chips are retained but demoted to a footer row: essential for trust,
 * useless for scanning, so they must not compete with the content.
 *
 * Takes its helpers as arguments rather than reaching into app.js, so this file
 * has no hidden coupling to load order.
 */
function mentionCard(m, ctx) {
  const { esc, brandName, fmtDate, verifChip, aliasesFor } = ctx;
  const pid = platformOf(m);
  const platform = PLATFORMS[pid] || PLATFORMS.web;
  const aliases = aliasesFor(m.brand);

  // Prefer the mention's own words: a title is often just the page <title>
  // ("The Boring Developer (@boringdev77) on X"), which says nothing about the
  // product. The evidence excerpt is the text that actually mentioned it.
  const body = m.evidence || m.title || "";
  const rel = relTime(m.date || m.first_seen);
  const followers =
    m.engagement && m.engagement.author_followers != null
      ? compactNum(m.engagement.author_followers)
      : null;

  const tags = [];
  if (m.mention_type) tags.push({ t: prettyTag(m.mention_type), title: m.mention_type_basis || "" });
  for (const pt of m.provider_tags || []) {
    const label = prettyTag(pt);
    if (!tags.some(x => x.t === label)) tags.push({ t: label, title: "provider-supplied tag" });
  }

  const whenTitle = m.date
    ? `Published ${fmtDate(m.date)}`
    : `No publication date on the page — first seen by our collector ${fmtDate(m.first_seen)}`;

  return `<article class="card mention premium">
    <div class="pm-head">
      ${platformMark(pid, 20)}
      <div class="pm-title">
        <span class="pm-lead">Mention of</span>
        <span class="pm-brand">${esc(brandName(m.brand))}</span>
        <span class="pm-lead">in</span>
        <span class="pm-plat" style="color:${platform.color}">${esc(platform.label)}</span>
        ${rel ? `<span class="pm-dot">·</span><span class="pm-time" title="${esc(whenTitle)}">${esc(rel)}</span>` : ""}
        ${m.author ? `<span class="pm-dot">·</span><span class="pm-author">by ${esc(m.author)}${followers ? ` <span class="pm-foll">(${followers} followers)</span>` : ""}</span>` : ""}
      </div>
      <a class="pm-icon" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer" title="Open the original source">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/></svg>
      </a>
      <button class="pm-icon" data-prov="${esc(m.url)}" title="Show full provenance">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12S19 18.5 12 18.5 1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
    </div>

    <p class="pm-body">${highlightBrand(body, m.brand, aliases)}</p>

    ${m.relevance_comment
      ? `<p class="pm-note">${esc(m.relevance_comment)}</p>`
      : m.sentiment_quote
        ? `<p class="pm-note">Sentiment judged from: “${esc(m.sentiment_quote)}”</p>`
        : ""}

    <div class="pm-foot">
      ${m.sentiment
        ? `<span class="pm-sent s-${esc(m.sentiment)}" title="${esc(m.sentiment_method || "classified")}">${SENT_FACE[m.sentiment] || ""} ${esc(m.sentiment[0].toUpperCase() + m.sentiment.slice(1))}</span>`
        : `<span class="pm-sent s-unclassified" title="Not yet classified — deliberately not counted as neutral">◌ Unclassified</span>`}
      ${tags.map(t => `<span class="pm-tag" title="${esc(t.title)}">${esc(t.t)}</span>`).join("")}
      ${m.buying_intent ? `<span class="pm-tag intent" title="${esc(m.buying_intent_basis || "buying intent detected")}">Buying Intent</span>` : ""}
      ${(m.comparison_products || []).length ? `<span class="pm-tag cmp">vs ${esc(m.comparison_products.map(c => c.name).join(", "))}</span>` : ""}
      <span class="pm-spacer"></span>
      <span class="pm-src">
        <a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(m.domain || "source")}</a>
        ${verifChip(m)}
        ${m.date_confidence !== "exact" ? `<span class="chip warn" title="No publication date could be proven; placed in the range by discovery date">no date</span>` : ""}
        ${!m.link_ok ? `<span class="chip bad" title="URL was not reachable at collection time">link dead</span>` : ""}
        <span class="chip src" title="Retrieved via ${esc(m.api_source || m.source)}${(m.also_seen_in || []).length ? "; also seen in " + esc(m.also_seen_in.join(", ")) : ""}">${esc(m.api_source || m.source)}${(m.also_seen_in || []).length ? " +" + m.also_seen_in.length : ""}</span>
      </span>
    </div>
  </article>`;
}

window.D360Premium = {
  PLATFORMS, platformOf, platformMark, highlightBrand, relTime, compactNum,
  prettyTag, SENT_FACE, escP, mentionCard,
};
