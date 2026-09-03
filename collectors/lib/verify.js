/**
 * Verification + extraction from fetched HTML/XML.
 *
 * This is the anti-hallucination layer. Rules enforced here:
 *
 *  1. A mention only exists if the brand name literally appears in the fetched
 *     page text. No inference, no "probably about".
 *  2. A date is only "exact" if it was parsed out of the page (JSON-LD,
 *     meta tags, <time datetime>, or a feed's own date field). Otherwise the
 *     record carries date_confidence:"unknown" and is EXCLUDED from date-range
 *     filtering rather than silently bucketed as recent.
 *  3. Every sentiment classification must be attached to a verbatim excerpt
 *     copied out of the fetched text, so a human can audit the call.
 *
 * No LLM at this layer either. Pure parsing of bytes we hold.
 */

const BLOCK_TAGS = /<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Site chrome. Removed before text extraction because a brand's own name appears
 * in its nav on every page, and an excerpt of a nav menu is not evidence of
 * anything — it produced excerpts like "News & Trends Product Updates . Product
 * Engineering . Best Practices" which no one can judge sentiment from.
 */
const CHROME_TAGS = /<(nav|header|footer|aside|form|button|select)\b[^>]*>[\s\S]*?<\/\1>/gi;
const CHROME_ATTR =
  /<(div|section|ul|ol)\b[^>]*(?:class|id)=["'][^"']*(?:nav|menu|header|footer|sidebar|breadcrumb|cookie|banner|subscribe|newsletter|social|share|related|widget|pagination)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(+d); } catch (e) { return " "; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return " "; }
    });
}

/**
 * Strip markup down to visible text, preserving sentence boundaries.
 * When the page exposes a clear content region (<article> / <main>), prefer it —
 * that alone removes most chrome without heuristics.
 */
function htmlToText(html) {
  if (!html) return "";
  let src = String(html);

  const region =
    src.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) ||
    src.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i) ||
    src.match(/<div\b[^>]*(?:class|id)=["'][^"']*(?:post-content|entry-content|article-body|blog-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  if (region && region[1] && region[1].length > 400) src = region[1];

  return decodeEntities(
    src
      .replace(BLOCK_TAGS, " ")
      .replace(CHROME_TAGS, " ")
      .replace(CHROME_ATTR, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, ". ")
      .replace(/<br\s*\/?>/gi, ". ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .replace(/(\.\s*){2,}/g, ". ")
    .trim();
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ dates */

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Normalise many date shapes to YYYY-MM-DD, or null if not confidently parseable. */
function toIsoDate(v) {
  if (!v) return null;
  const s = String(v).trim();

  // GDELT: 20260809T120000Z
  const g = s.match(/^(\d{4})(\d{2})(\d{2})T\d{6}Z?$/);
  if (g) return `${g[1]}-${g[2]}-${g[3]}`;

  if (ISO_RE.test(s)) {
    const m = s.match(ISO_RE);
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (!isNaN(d)) return `${m[1]}-${m[2]}-${m[3]}`;
    return null;
  }

  // Date-only strings like "Mar 5, 2026" are parsed by JS as LOCAL midnight, and
  // toISOString() then converts to UTC — shifting the date back a day for any
  // timezone west of UTC. Measured: "Mar 5, 2026" produced 2026-03-04. Parse
  // date-only values explicitly as UTC so the calendar date survives.
  const dateOnly = s.match(
    /^(\d{1,2})?\s*([A-Za-z]{3,9})\.?\s+(\d{1,2})?,?\s*(\d{4})$/
  );
  if (dateOnly) {
    const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const mi = MONTHS.indexOf(dateOnly[2].slice(0, 3).toLowerCase());
    const day = parseInt(dateOnly[1] || dateOnly[3], 10);
    const year = parseInt(dateOnly[4], 10);
    if (mi >= 0 && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {
      const utc = new Date(Date.UTC(year, mi, day));
      if (!isNaN(utc)) return utc.toISOString().slice(0, 10);
    }
  }

  const d = new Date(s);
  if (isNaN(d)) return null;
  // Reject absurd values that indicate a parse accident rather than a real date.
  const y = d.getUTCFullYear();
  if (y < 2000 || y > 2100) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Pull a published date out of a page, recording HOW it was found so the
 * dashboard can show provenance instead of an unexplained date.
 * Returns { date, method } or { date:null, method:null }.
 */
function extractPublishedDate(html) {
  if (!html) return { date: null, method: null };

  // 1. JSON-LD datePublished — most reliable when present.
  const ldBlocks = [...String(html).matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of ldBlocks) {
    const raw = b[1].trim();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { /* some sites emit invalid JSON-LD */ }
    const found = parsed && findKeyDeep(parsed, ["datePublished", "dateCreated", "uploadDate"]);
    const iso = toIsoDate(found);
    if (iso) return { date: iso, method: "json-ld" };
  }
  // Fall back to a regex over raw JSON-LD text if JSON.parse failed.
  for (const b of ldBlocks) {
    const m = b[1].match(/"(?:datePublished|uploadDate|dateCreated)"\s*:\s*"([^"]+)"/);
    const iso = m && toIsoDate(m[1]);
    if (iso) return { date: iso, method: "json-ld-regex" };
  }

  // 2. Standard meta tags.
  const metaPatterns = [
    [/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i, "meta:article:published_time"],
    [/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i, "meta:article:published_time"],
    [/<meta[^>]+name=["'](?:pubdate|publishdate|publication_date|date|DC\.date\.issued|parsely-pub-date|sailthru\.date)["'][^>]+content=["']([^"']+)["']/i, "meta:date"],
    [/<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/i, "meta:itemprop"],
    [/<meta[^>]+property=["']og:published_time["'][^>]+content=["']([^"']+)["']/i, "meta:og:published_time"],
  ];
  for (const [re, method] of metaPatterns) {
    const m = String(html).match(re);
    const iso = m && toIsoDate(m[1]);
    if (iso) return { date: iso, method };
  }

  // 3. <time datetime="...">
  const t = String(html).match(/<time[^>]+datetime=["']([^"']+)["']/i);
  const tIso = t && toIsoDate(t[1]);
  if (tIso) return { date: tIso, method: "time[datetime]" };

  // 4. Visible "Published on 5 March 2026" / "Mar 5, 2026" text near the top.
  // Restricted to the first 12KB of extracted text so a comment thread or an
  // unrelated sidebar date does not get mistaken for the publication date.
  const head = htmlToText(String(html).slice(0, 60000)).slice(0, 12000);
  const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*";
  const visible = [
    [new RegExp(`(?:published|posted|updated|last updated)\\s*(?:on|:)?\\s*(${MONTH}\\s+\\d{1,2},?\\s+20\\d{2})`, "i"), "text:published-label"],
    [new RegExp(`(?:published|posted|updated)\\s*(?:on|:)?\\s*(\\d{1,2}\\s+${MONTH}\\s+20\\d{2})`, "i"), "text:published-label"],
    [new RegExp(`\\b(${MONTH}\\s+\\d{1,2},\\s+20\\d{2})\\b`), "text:date-in-body"],
    [new RegExp(`\\b(\\d{1,2}\\s+${MONTH}\\s+20\\d{2})\\b`), "text:date-in-body"],
  ];
  const todayIso = new Date().toISOString().slice(0, 10);
  for (const [re, method] of visible) {
    const m = head.match(re);
    const iso = m && toIsoDate(m[1].replace(/,/g, ""));
    // A publication date cannot be in the future. This path scrapes loose body
    // text, so it can pick up an upcoming-event date from a listing page —
    // measured: idratherbewriting.com/all/ yielded 2026-09-20 while "today" was
    // 2026-08-31. A future date would also clamp to "0 days ago" and pollute the
    // recent buckets, so it is rejected rather than stored.
    if (iso && iso <= todayIso) return { date: iso, method };
  }

  return { date: null, method: null };
}

/**
 * Dates recoverable from the URL itself — no page fetch needed, and exact.
 *
 * Two cases matter a lot here because they were the biggest sources of undated
 * records:
 *   - Blogs and news sites that embed the date in the path (/2026/08/12/slug)
 *   - X/Twitter status URLs. A tweet ID is a Snowflake: the top 41 bits are
 *     milliseconds since the Twitter epoch (2010-11-04T01:42:54.657Z), so the
 *     exact post time is derivable arithmetically from the ID with no API call.
 */
function dateFromUrl(u) {
  const s = String(u || "");

  // X / Twitter snowflake
  const tw = s.match(/(?:twitter|x)\.com\/[^/]+\/status(?:es)?\/(\d{15,25})/i);
  if (tw) {
    try {
      const ms = (BigInt(tw[1]) >> 22n) + 1288834974657n;
      const d = new Date(Number(ms));
      const y = d.getUTCFullYear();
      if (y >= 2006 && y <= 2100) {
        return { date: d.toISOString().slice(0, 10), method: "x:snowflake-id" };
      }
    } catch (e) { /* not a usable id */ }
  }

  // Date embedded in the path: /2026/08/12/ or /2026-08-12-
  const p = s.match(/\/(20\d{2})[/\-](0[1-9]|1[0-2])[/\-](0[1-9]|[12]\d|3[01])(?:[/\-]|$)/);
  if (p) {
    const iso = `${p[1]}-${p[2]}-${p[3]}`;
    const d = new Date(iso + "T00:00:00Z");
    if (!isNaN(d) && d <= new Date()) return { date: iso, method: "url:path-date" };
  }
  // Year/month only: /2026/08/
  const pm = s.match(/\/(20\d{2})\/(0[1-9]|1[0-2])\//);
  if (pm) {
    const iso = `${pm[1]}-${pm[2]}-01`;
    const d = new Date(iso + "T00:00:00Z");
    if (!isNaN(d) && d <= new Date()) return { date: iso, method: "url:path-year-month" };
  }

  return { date: null, method: null };
}

function findKeyDeep(obj, keys, depth = 0) {
  if (!obj || depth > 6) return null;
  if (Array.isArray(obj)) {
    for (const o of obj) {
      const r = findKeyDeep(o, keys, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof obj !== "object") return null;
  for (const k of keys) if (obj[k]) return obj[k];
  for (const v of Object.values(obj)) {
    const r = findKeyDeep(v, keys, depth + 1);
    if (r) return r;
  }
  return null;
}

/* ------------------------------------------------------------------ titles */

function extractTitle(html) {
  if (!html) return null;
  const og = String(html).match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return decodeEntities(og[1]).trim();
  const t = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) return decodeEntities(t[1]).replace(/\s+/g, " ").trim();
  const h1 = String(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return htmlToText(h1[1]).trim() || null;
  return null;
}

/* ------------------------------------------------- mention confirmation */

/**
 * Confirm at least one alias literally occurs in the page text.
 * Returns { present, matched_alias, occurrences }.
 */
function confirmMention(text, aliases) {
  const hay = norm(text);
  if (!hay) return { present: false, matched_alias: null, occurrences: 0 };
  let best = null;
  let count = 0;
  for (const a of aliases) {
    const needle = norm(a);
    if (!needle) continue;
    // Word-boundary-ish match so "Guru" doesn't match "gurus" spuriously in
    // a way we can't see; we still allow punctuation adjacency.
    const re = new RegExp("(^|[^a-z0-9])" + escapeRe(needle) + "([^a-z0-9]|$)", "g");
    const hits = (hay.match(re) || []).length;
    if (hits > 0) {
      count += hits;
      if (!best) best = a;
    }
  }
  return { present: count > 0, matched_alias: best, occurrences: count };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract a verbatim excerpt around the first alias occurrence.
 * This excerpt is the evidence a sentiment call must be based on, and it is
 * shown in the UI so the classification is auditable.
 */
/**
 * Score an excerpt on how much it reads like prose rather than a list of links.
 * Navigation and tag clouds collapse into short ". "-separated fragments, so mean
 * fragment length separates them from real sentences cleanly. Higher is better.
 */
function proseScore(s) {
  const frags = String(s).split(/\.\s|\|/).map(f => f.trim()).filter(Boolean);
  if (!frags.length) return 0;
  const mean = frags.reduce((a, f) => a + f.split(/\s+/).length, 0) / frags.length;
  const words = s.split(/\s+/).length;
  // Real sentences contain function words; nav fragments rarely do.
  const functionWords = (s.match(/\b(is|are|was|were|the|a|an|that|with|for|but|and|to|of|in|it|this|has|have|can|as|than|because|however|while)\b/gi) || []).length;
  return mean * 2 + (functionWords / Math.max(words, 1)) * 40;
}

function extractEvidence(text, aliases, maxLen = 400) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const hay = clean.toLowerCase();

  // Collect every occurrence of every alias, not just the first — the first is
  // often in site chrome, and the useful mention is further down the page.
  const hits = [];
  for (const a of aliases) {
    const needle = String(a).toLowerCase();
    let from = 0;
    while (hits.length < 40) {
      const i = hay.indexOf(needle, from);
      if (i === -1) break;
      hits.push({ idx: i, alias: a });
      from = i + needle.length;
    }
  }
  if (!hits.length) return null;

  const half = Math.floor(maxLen / 2);
  const windows = hits.map(h => {
    const rawStart = Math.max(0, h.idx - half);
    const rawEnd = Math.min(clean.length, h.idx + half);
    let start = rawStart;
    let end = rawEnd;

    // Snap to sentence boundaries for readability...
    const sp = clean.lastIndexOf(". ", start + 40);
    if (sp > 0 && sp > start - 120) start = sp + 2;
    const ep = clean.indexOf(". ", end - 40);
    if (ep !== -1 && ep < end + 120) end = ep + 1;

    // ...but never at the cost of dropping the matched mention out of the
    // excerpt. Evidence that does not contain the brand name is not evidence of
    // a brand mention, so fall back to the unsnapped window in that case.
    const aliasEnd = h.idx + String(h.alias).length;
    if (h.idx < start || aliasEnd > end) {
      start = rawStart;
      end = rawEnd;
    }

    const excerpt = clean.slice(start, end).trim();
    return { ...h, start, end, excerpt, score: proseScore(excerpt) };
  });

  windows.sort((a, b) => b.score - a.score);
  const best = windows[0];

  return {
    excerpt: (best.start > 0 ? "…" : "") + best.excerpt + (best.end < clean.length ? "…" : ""),
    matched_alias: best.alias,
    char_offset: best.idx,
    prose_score: Math.round(best.score * 10) / 10,
    occurrences_considered: windows.length,
  };
}

/* ------------------------------------------------------------------ urls */

/** Canonical form for dedupe: drop tracking params, trailing slash, fragment. */
function canonicalUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    const strip = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^ref$/i, /^source$/i, /^mc_cid$/i, /^mc_eid$/i, /^igshid$/i, /^si$/i];
    for (const k of [...url.searchParams.keys()]) {
      if (strip.some(re => re.test(k))) url.searchParams.delete(k);
    }
    let s = url.toString();
    s = s.replace(/\/$/, "");
    return s;
  } catch (e) {
    return String(u || "");
  }
}

function domainOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ feeds */

/** Minimal RSS/Atom parser. Returns items with the feed's own dates (exact). */
function parseFeed(xml) {
  if (!xml) return [];
  const items = [];
  const blocks = [
    ...String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi),
    ...String(xml).matchAll(/<entry\b[\s\S]*?<\/entry>/gi),
  ];
  for (const b of blocks) {
    const s = b[0];
    const pick = (...tags) => {
      for (const t of tags) {
        const m = s.match(new RegExp("<" + t + "\\b[^>]*>([\\s\\S]*?)</" + t + ">", "i"));
        if (m) {
          const inner = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
          const v = decodeEntities(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
          if (v) return v;
        }
      }
      return null;
    };
    // Atom links live in an attribute.
    let link = pick("link");
    if (!link || !/^https?:/i.test(link)) {
      const lm = s.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (lm) link = lm[1];
    }
    const dateRaw = pick("pubDate", "published", "updated", "dc:date");
    items.push({
      title: pick("title"),
      url: link,
      published_raw: dateRaw,
      published: toIsoDate(dateRaw),
      summary: pick("description", "summary", "content", "media:description"),
      author: pick("dc:creator", "author", "name"),
      id: pick("guid", "id"),
    });
  }
  return items.filter(i => i.url);
}

/**
 * Is this scraped description fit to display?
 *
 * Some sites ship an unrendered template in their own meta description.
 * Measured: liveagent.com serves
 *   "${e.title} ${t?` ${s}. `:""} ${e.title} . ${n}."
 * That is faithfully-captured page content, so it is not a scraping bug — but
 * it tells a reader nothing, and rendering it looks like OUR template broke.
 *
 * Returns false for template artefacts, cookie banners and JS boilerplate, so
 * the caller can report "no usable description" instead.
 */
const TEMPLATE_ARTEFACT = [
  /\$\{[^}]*\}/,            // JS template literal: ${e.title}
  /\{\{[^}]*\}\}/,          // Handlebars / Vue / Angular: {{ title }}
  /%[A-Z_]{3,}%/,           // token placeholders: %PRODUCT_NAME%
  /\[object \w+\]/,
  /\bundefined\b\s*\.?\s*$/i,
  /^\s*(?:null|undefined|NaN)\s*$/i,
];
const NON_DESCRIPTION = [
  /\byou need to enable javascript\b/i,
  /\bwe use cookies\b/i,
  /\benable cookies\b/i,
  /\bplease enable\b.{0,20}\bbrowser\b/i,
  /\baccess denied\b/i,
  /\bchecking your browser\b/i,
];

function isUsableDescription(text) {
  const s = String(text || "").trim();
  if (s.length < 20) return { ok: false, reason: "too short to be a description" };

  /* `reason` is display text and deliberately does NOT quote the offending
   * string. Echoing `${e.title}` back into the page is no use to a reader, and
   * it makes any downstream "did our template leak?" check fire on the
   * explanation itself. The matched text goes in `matched` for auditing. */
  for (const re of TEMPLATE_ARTEFACT) {
    const m = s.match(re);
    if (m) {
      return {
        ok: false,
        reason: "the site publishes an unrendered template as its description",
        matched: m[0].slice(0, 60),
        kind: "template_artefact",
      };
    }
  }
  for (const re of NON_DESCRIPTION) {
    const m = s.match(re);
    if (m) {
      return {
        ok: false,
        reason: "the site publishes boilerplate rather than a description",
        matched: m[0].slice(0, 60),
        kind: "boilerplate",
      };
    }
  }
  return { ok: true };
}

module.exports = {
  isUsableDescription,
  htmlToText,
  decodeEntities,
  extractPublishedDate,
  dateFromUrl,
  extractTitle,
  confirmMention,
  extractEvidence,
  canonicalUrl,
  domainOf,
  parseFeed,
  toIsoDate,
  norm,
};
