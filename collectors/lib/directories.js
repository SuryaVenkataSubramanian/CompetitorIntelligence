/**
 * Review-directory listing extraction.
 *
 * Turns a search result on G2 / Capterra / GetApp / TrustRadius / Gartner /
 * SoftwareAdvice / SoftwareSuggest into a candidate product listing — or
 * rejects it with a reason.
 *
 * THE TWO JUDGEMENTS THIS FILE MAKES, AND WHY THEY ARE SEPARATE
 * ------------------------------------------------------------
 *   1. Is this a PRODUCT page?  Decided from the URL shape alone, per
 *      directory. A compare page or an "alternatives" page names a product
 *      without listing it, and counting those would invent listings.
 *   2. Does the listing place the product in the CATEGORY?  Decided from the
 *      listing's own title and snippet, never from the query that found it.
 *
 * Keeping them separate matters because they fail independently: a real product
 * page can carry no category evidence, and that is a partially-known result
 * rather than a rejection.
 *
 * Measured motivation: `site:trustradius.com/products customer self service`
 * returns Paycom, BambooHR and ADP Workforce Now — payroll and HR products that
 * rank for support phrasing. Judgement 2 is what excludes them.
 */
const CFG = require("../../config/directories.json");
const { allBrands, brandOrder, brand } = require("./brands");

const DIRECTORIES = CFG.directories;
const CATEGORIES = CFG.categories;
const LIMITS = CFG._limits || {};

const byId = Object.fromEntries(DIRECTORIES.map(d => [d.id, d]));
const catById = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

/* ------------------------------------------------------------------ exclusion */

/**
 * Products that are not new arrivals: the 7 this dashboard already tracks, plus
 * the incumbent list used by web discovery. Reused rather than duplicated so
 * the two collectors cannot drift apart.
 */
function buildExclusions() {
  const kw = require("../../config/keywords.json");
  const tracked = new Map();
  for (const b of allBrands()) {
    for (const a of b.aliases) tracked.set(norm(a), b.id);
    tracked.set(norm(b.name), b.id);
  }
  const incumbents = new Set((kw.exclude_incumbents || []).map(norm));
  return { tracked, incumbents };
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Is this candidate one of ours, or a known incumbent?
 * Returns the reason, or null when it is genuinely a new name.
 */
function exclusionReason(name, slug, ex) {
  const n = norm(name);
  const s = norm(slug);

  if (ex.tracked.has(n)) return `tracked product (${ex.tracked.get(n)})`;
  if (ex.tracked.has(s)) return `tracked product (${ex.tracked.get(s)})`;

  if (ex.incumbents.has(n) || ex.incumbents.has(s)) return "known incumbent";

  /* A vendor's product line carries the vendor name as its first word:
   * "Zoho Desk", "ManageEngine ADSelfService Plus", "Atlassian Confluence".
   *
   * Measured bug this fixes: the prefix rule below requires >=5 characters, so
   * the incumbent "zoho" (4) never matched and "Zoho Desk" was admitted as a
   * new product. Checking the first TOKEN of the name is both precise and
   * length-independent — an exact word match, not a substring. */
  const firstToken = norm(String(name || "").trim().split(/[\s.\-–—:]+/)[0]);
  if (firstToken.length >= 3) {
    if (ex.incumbents.has(firstToken)) return `product line of a known incumbent (${firstToken})`;
    if (ex.tracked.has(firstToken)) return `product line of a tracked product (${ex.tracked.get(firstToken)})`;
  }

  /* Prefix match for variants written without a space: "confluencecloud",
   * "proprofskb". Bounded at 5 characters so short words cannot swallow
   * unrelated names — the first-token rule above covers the short ones. */
  for (const inc of ex.incumbents) {
    if (inc.length >= 5 && (n.startsWith(inc) || s.startsWith(inc))) {
      return `known incumbent variant (${inc})`;
    }
  }
  for (const [alias, id] of ex.tracked) {
    if (alias.length >= 5 && (n.startsWith(alias) || s.startsWith(alias))) {
      return `tracked product variant (${id})`;
    }
  }
  return null;
}

/* -------------------------------------------------------------- name parsing */

/**
 * The product's display name.
 *
 * The result TITLE is preferred over the URL slug: a title reads
 * "eGain Knowledge AI Reviews 2026: … - G2", which carries the real casing and
 * spacing, while the slug "egain-knowledge-ai" would have to be guessed back
 * into "eGain Knowledge AI" and would get the capitalisation wrong.
 *
 * The slug is the fallback, and which source was used is recorded.
 */
/**
 * Words that describe the CATEGORY rather than identify a PRODUCT.
 *
 * A name built entirely from these is a category page or a placeholder, not a
 * product. Measured admissions before this gate: "Customer Portal",
 * "Knowledge Management", "Contact Center Knowledge Base Software",
 * "Customer Self-Service Portal", "Vendor Portal", "Free Document Maker".
 *
 * The trade-off is deliberate and stated: a real product whose name is purely
 * descriptive — "Documentation AI" is the honest example — is rejected too. It
 * lands in the visible `generic_name` reject bucket rather than disappearing,
 * and losing one such product costs less than admitting six category pages as
 * competitors.
 */
const CATEGORY_WORDS = new Set([
  "customer", "client", "user", "employee", "vendor", "partner", "agent", "admin",
  "self", "service", "services", "portal", "center", "centre", "hub", "desk",
  "knowledge", "management", "base", "contact", "call", "help", "support",
  "software", "system", "systems", "tool", "tools", "platform", "solution", "solutions",
  "document", "documents", "documentation", "doc", "docs", "maker", "generator",
  "api", "apis", "standard", "operating", "procedure", "procedures", "sop", "sops",
  "process", "dynamic", "universal", "free", "online", "cloud", "enterprise",
  "ai", "app", "suite", "manager", "pro", "plus", "the", "and", "for", "of", "with",
]);

/**
 * Is this name purely category vocabulary?
 * Requires at least two tokens: a single generic token like "Shelf" or "Relay"
 * is a legitimate product name, and rejecting those would cost real findings.
 */
function isGenericName(name) {
  const tokens = String(name || "")
    .replace(/[()[\]]/g, " ")
    .split(/[\s.\-–—:/_&,]+/)
    .map(t => t.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
  if (tokens.length < 2) return false;
  return tokens.every(t => CATEGORY_WORDS.has(t));
}

/** Boilerplate that is never part of a product's name. */
const TITLE_NOISE = [
  // Paginated review listings put the page number first: a first pass produced
  // the product name "Page 10 | n8n".
  /^\s*Page\s+\d+\s*[|\-–—:]\s*/i,
  /^\s*\d+\s*[|\-–—]\s*/,
  /^\s*(?:Best|Top)\s+\d*\s*/i,
  /^\s*Compare\s+/i,
];

/**
 * Suffixes left on a name after the directory boilerplate is stripped.
 *
 * Applied AFTER the per-directory rules, because they are cross-directory:
 * SoftwareAdvice titles end "<Name> Software", GetApp appends the year. Left
 * in, they split one product into several — measured: "DocuWriter.ai" and
 * "DocuWriter.ai Software" were counted as two products, and "DHTMLX - 2026"
 * would never match "DHTMLX" from another directory.
 */
const NAME_SUFFIX = [
  /\s+Software$/i,
  /\s*[-–—]?\s*(?:19|20)\d{2}$/,     // trailing year: "DHTMLX - 2026"
  /\s+(?:Reviews?|Pricing|Features|Alternatives|Details)$/i,
  /\s*[-–—:|,.]+$/,
];

function extractName(title, slug, dir) {
  let t = String(title || "").trim();
  for (const noise of TITLE_NOISE) t = t.replace(noise, "").trim();
  for (const pat of dir.title_strip || []) {
    t = t.replace(new RegExp(pat, "i"), "").trim();
  }
  // Repeat the suffix pass: stripping one can expose another
  // ("X Software 2026" → "X Software" → "X").
  for (let pass = 0; pass < 3; pass++) {
    const before = t;
    for (const re of NAME_SUFFIX) t = t.replace(re, "").trim();
    if (t === before) break;
  }

  // A title reduced to nothing, or to something implausibly long, is unusable.
  // A name still containing a separator is boilerplate we failed to strip.
  const usable = t && t.length >= 2 && t.length <= 60 &&
    !/^(best|top|compare|reviews?|page)\b/i.test(t) &&
    !/\|/.test(t);
  if (usable) return { name: t, source: "listing title" };

  const fromSlug = String(slug || "")
    .split("-")
    .filter(Boolean)
    .map(w => (w.length <= 3 && /^[a-z]+$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
  return {
    name: fromSlug || null,
    // Flagged, because slug-derived casing is a guess ("Docuwriter.ai" vs
    // "DocuWriter.ai") and should not be presented as the vendor's own styling.
    source: "URL slug (title unusable — casing approximate)",
  };
}

/* -------------------------------------------------- product-page recognition */

/**
 * Classify one search result against one directory.
 * Returns { ok:true, slug } or { ok:false, reason }.
 */
function matchProductPage(url, dir) {
  const u = String(url || "");
  if (!u) return { ok: false, reason: "no url" };

  if (dir.reject_url && new RegExp(dir.reject_url, "i").test(u)) {
    return { ok: false, reason: "not a product page (compare/alternatives/category URL)" };
  }
  const m = u.match(new RegExp(dir.product_url, "i"));
  if (!m) return { ok: false, reason: "URL does not match this directory's product-page shape" };

  const slug = m[1];
  if (!slug || slug.length < 2) return { ok: false, reason: "no product slug in URL" };
  return { ok: true, slug };
}

/* ------------------------------------------------- category confirmation */

/**
 * Does the listing's OWN text place this product in the category?
 *
 * Judged on title + snippet + the URL path (which several directories use to
 * encode the market, e.g. Gartner's `marketSeoName=knowledge`). Never on the
 * search term, which is the whole point.
 */
function confirmCategory(categoryId, { title, snippet, url }) {
  const cat = catById[categoryId];
  if (!cat) return { confirmed: false, reason: `unknown category ${categoryId}` };

  const listingText = [title, snippet].filter(Boolean).join(" ");
  const pathText = decodeURIComponent(String(url || "")).replace(/[-_/?=&]+/g, " ");

  // A disqualifying signal wins: a payroll product is not a knowledge base even
  // if the word "knowledge" appears somewhere in its blurb.
  if (cat.reject) {
    const rej = listingText.match(new RegExp(cat.reject, "i"));
    if (rej) {
      return {
        confirmed: false,
        rejected: true,
        reason: `its own listing describes a different category (matched "${rej[0]}")`,
        matched: rej[0],
      };
    }
  }

  const re = new RegExp(cat.confirm, "i");
  const inListing = listingText.match(re);
  if (inListing) {
    return { confirmed: true, matched: inListing[0], where: "listing title/snippet", strength: "strong" };
  }
  const inPath = pathText.match(re);
  if (inPath) {
    return { confirmed: true, matched: inPath[0], where: "directory URL path", strength: "moderate" };
  }
  return {
    confirmed: false,
    reason:
      "the listing's own title, snippet and URL carry no evidence of this category — " +
      "it was returned by a category search but does not place itself in it",
  };
}

/* ---------------------------------------------------------------- confidence */

/**
 * Confidence that this is a real, correctly-categorised new listing.
 * Built from what was actually established, so it is explainable.
 */
function confidence({ nameSource, categoryConfirm, directoryId, corroborations = 0 }) {
  let c = 0.35;
  const why = [];

  if (nameSource === "listing title") { c += 0.2; why.push("name from the listing's own title"); }
  else { why.push("name derived from the URL slug (casing approximate)"); }

  if (categoryConfirm.confirmed && categoryConfirm.strength === "strong") {
    c += 0.3; why.push(`category confirmed in the listing text ("${categoryConfirm.matched}")`);
  } else if (categoryConfirm.confirmed) {
    c += 0.15; why.push(`category inferred from the directory URL ("${categoryConfirm.matched}")`);
  } else {
    c -= 0.1; why.push("category not confirmed by the listing");
  }

  // SoftwareSuggest shares one flat URL space between products and categories,
  // so its product-page test is structurally weaker than the others'.
  if (directoryId === "softwaresuggest") { c -= 0.12; why.push("SoftwareSuggest uses one URL space for products and categories"); }

  // Appearing on more than one directory is independent corroboration.
  if (corroborations > 0) {
    c += Math.min(0.2, corroborations * 0.1);
    why.push(`listed on ${corroborations + 1} directories`);
  }

  return { score: Math.max(0.1, Math.min(0.97, Math.round(c * 100) / 100)), basis: why };
}

/* ------------------------------------------------------------------ queries */

/** The `site:` queries for one directory × category. */
function queriesFor(directoryId, categoryId) {
  const d = byId[directoryId];
  const c = catById[categoryId];
  if (!d || !c) return [];
  return c.terms.map(t => `${d.search_scope} ${t}`);
}

module.exports = {
  DIRECTORIES, CATEGORIES, LIMITS,
  byId, catById,
  buildExclusions, exclusionReason, norm,
  extractName, matchProductPage, confirmCategory, confidence, queriesFor,
  isGenericName, CATEGORY_WORDS,
};
