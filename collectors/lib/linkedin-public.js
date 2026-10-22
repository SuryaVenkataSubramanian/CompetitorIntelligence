/**
 * LinkedIn post enrichment, keyless.
 *
 * WHAT THIS REPLACES, AND WHY IT IS WORTH REPLACING
 * -------------------------------------------------
 * The Apify LinkedIn actor costs $0.0020 a post and was bought for exactly two
 * things the free SerpAPI `site:` route could not supply: an exact publication
 * date, and the author's real name. Google's snippet carries neither, so those
 * records were undated and 19 of 38 authors had to be recovered by regex.
 *
 * MEASURED: LinkedIn's post page is authwalled — it answers HTTP 200 with a
 * "join now to see" interstitial — but the <head> it serves to crawlers still
 * contains both facts, keyless:
 *
 *   "datePublished": "2026-09-29T10:02:18.203Z"      exact, to the second
 *   og:title        "<text> | <Author> posted on the topic | LinkedIn"
 *   og:description  the post body
 *
 * So discovery stays with SerpAPI (one search per brand) and enrichment becomes
 * free. That removes the LinkedIn half of the Apify bill entirely.
 *
 * THE TRAP THAT NEARLY GOT WRITTEN IN
 * -----------------------------------
 * The page also carries a JSON-LD "author" object, which looks authoritative
 * and IS WRONG. Measured on three posts:
 *
 *   og:title "…| Noman Ahmed"            JSON-LD author "Marcin I."
 *   og:title "…| Opemipo Jokotagba…"     JSON-LD author "Kunal J Valecha"
 *
 * The first `"author"` in the document belongs to a COMMENT, not the post. A
 * naive JSON-LD read would have attributed every post to whoever commented
 * first — confidently, and with a structured-data field to point at. og:title
 * is the one LinkedIn actually renders as the byline, so that is what is read.
 */
const { fetchUrl } = require("./fetch");
const { decodeEntities, toIsoDate } = require("./verify");

/** Only a post permalink carries this metadata; a profile or company page does not. */
function isPostUrl(url) {
  return /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/posts\//i.test(String(url || ""));
}

function metaContent(html, property) {
  const re = new RegExp(
    '<meta[^>]+(?:property|name)="' + property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"[^>]+content="([^"]*)"',
    "i"
  );
  const m = re.exec(html);
  return m ? decodeEntities(m[1]) : null;
}

/**
 * The author, from the only field LinkedIn renders as a byline.
 *
 * Three shapes observed:
 *   "<text> | <Author> posted on the topic | LinkedIn"   the common one
 *   "<text> | <Author>"                                  shorter variant
 *   "#tag #tag #tag …"                                   no author at all
 *
 * Returns null rather than a guess for the third. "LinkedIn", "N comments" and
 * similar tail fragments are rejected explicitly — they are what a naive
 * split("|").pop() produces, and they look like names until you read them.
 */
function authorFromTitle(title) {
  if (!title) return null;

  const posted = /\|\s*([^|]{2,60}?)\s+posted on the topic/i.exec(title);
  if (posted) return clean(posted[1]);

  const onLinkedIn = /^([^|]{2,60}?)\s+on LinkedIn:/i.exec(title);
  if (onLinkedIn) return clean(onLinkedIn[1]);

  const parts = title.split("|").map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const tail = parts[parts.length - 1];
    if (!isNotAName(tail)) return clean(tail);
    // "…| <Author> | LinkedIn"
    if (parts.length >= 3 && !isNotAName(parts[parts.length - 2])) return clean(parts[parts.length - 2]);
  }
  return null;
}

/** Tail fragments that are not people. */
function isNotAName(s) {
  const t = String(s || "").trim();
  if (!t || t.length > 60) return true;
  if (/^linkedin$/i.test(t)) return true;
  if (/^\d+\s+(comments?|likes?|reactions?)$/i.test(t)) return true;
  if (/^#/.test(t)) return true;
  return false;
}

function clean(s) {
  return String(s).replace(/\s+/g, " ").trim() || null;
}

/**
 * Fetch one post and return what the page states about itself.
 *
 * Never throws, and never invents: a field the page does not carry comes back
 * null, so a caller can tell "LinkedIn did not say" from "we did not look".
 */
async function enrich(url, { timeout = 25000 } = {}) {
  if (!isPostUrl(url)) {
    return { ok: false, reason: "not a LinkedIn post permalink", url };
  }

  let r;
  try {
    r = await fetchUrl(url, { retries: 0, timeout, maxBytes: 4 * 1024 * 1024 });
  } catch (e) {
    return { ok: false, reason: "fetch threw: " + String(e.message || e), url };
  }
  if (!r.ok) return { ok: false, reason: `HTTP ${r.status}`, status: r.status, url };

  const html = String(r.body || "");

  // JSON-LD datePublished is the post's own timestamp and IS reliable, unlike
  // the author object beside it.
  const rawDate = (/"datePublished"\s*:\s*"([^"]+)"/.exec(html) || [])[1] || null;
  const published = rawDate ? toIsoDate(rawDate) : null;

  const title = metaContent(html, "og:title");
  const text = metaContent(html, "og:description") || metaContent(html, "description");

  return {
    ok: true,
    url,
    published_at: published,
    date_method: published ? "linkedin:JSON-LD datePublished" : null,
    author: authorFromTitle(title),
    author_method: "linkedin:og:title byline",
    text: text ? clean(text) : null,
    // Stated so a reader knows the body is the page's own summary of the post,
    // not a scrape of the rendered feed.
    text_source: text ? "og:description" : null,
    authwalled: /join now to see|authwall/i.test(html),
    bytes: r.bytes,
  };
}

module.exports = { enrich, isPostUrl, authorFromTitle };
