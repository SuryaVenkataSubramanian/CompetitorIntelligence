/**
 * Brand matching with disambiguation.
 *
 * Two of the seven tracked products are named after common English nouns
 * ("Confluence", "Guru"). A naive substring match would count "a confluence of
 * factors" and "SEO guru" as product mentions, which would silently inflate
 * share-of-voice — the exact kind of quiet inaccuracy that makes a dashboard
 * unusable for a business decision.
 *
 * So a match must satisfy, in order:
 *   1. an alias occurs as a whole word in the fetched text
 *   2. no negative_context phrase surrounds it
 *   3. for ambiguous brands, at least one require_context term is also present
 *
 * Every rejection is reported with a reason so tuning is evidence-driven.
 */
const fs = require("fs");
const path = require("path");
const { norm } = require("./verify");

const CONFIG_PATH = path.join(__dirname, "..", "..", "config", "brands.json");

let _cfg = null;
function config() {
  if (!_cfg) _cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  return _cfg;
}

function brandOrder() {
  return config().brand_order;
}
function brand(id) {
  const b = config().brands[id];
  if (!b) throw new Error("unknown brand id: " + id);
  return b;
}
function allBrands() {
  return brandOrder().map(id => ({ id, ...brand(id) }));
}
function eventConfig() {
  return config().event_sources;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word-ish alias occurrences, tolerant of adjacent punctuation. */
function aliasHits(text, alias) {
  const re = new RegExp("(^|[^a-z0-9])" + escapeRe(norm(alias)) + "([^a-z0-9]|$)", "g");
  return (norm(text).match(re) || []).length;
}

/**
 * Decide whether `text` genuinely mentions the brand.
 * Returns { present, matched_alias, occurrences, rejected_reason }.
 */
function matchBrand(text, brandId) {
  const b = brand(brandId);
  const hay = norm(text);
  if (!hay) return { present: false, matched_alias: null, occurrences: 0, rejected_reason: "empty text" };

  // 1. alias presence
  let matched = null;
  let occurrences = 0;
  for (const a of b.aliases) {
    const n = aliasHits(hay, a);
    if (n > 0) {
      occurrences += n;
      if (!matched) matched = a;
    }
  }
  if (!matched) {
    return { present: false, matched_alias: null, occurrences: 0, rejected_reason: "no alias in text" };
  }

  // 2. negative context disqualifies outright
  for (const neg of b.negative_context || []) {
    if (hay.includes(norm(neg))) {
      return {
        present: false,
        matched_alias: matched,
        occurrences,
        rejected_reason: `negative context matched: "${neg}"`,
      };
    }
  }

  // 3. ambiguous brands need corroborating product context
  const req = b.require_context || [];
  if (req.length) {
    const hit = req.find(t => hay.includes(norm(t)));
    if (!hit) {
      return {
        present: false,
        matched_alias: matched,
        occurrences,
        rejected_reason: `ambiguous name "${matched}" with no product context (needed one of: ${req.slice(0, 4).join(", ")}…)`,
      };
    }
    return { present: true, matched_alias: matched, occurrences, context_term: hit, rejected_reason: null };
  }

  return { present: true, matched_alias: matched, occurrences, rejected_reason: null };
}

/** Which of the 7 brands does this text mention? Used for co-mention analysis. */
function matchAllBrands(text) {
  const out = {};
  for (const id of brandOrder()) {
    const m = matchBrand(text, id);
    if (m.present) out[id] = m;
  }
  return out;
}

/** Search terms for a brand: quoted alias forms for exact-phrase search. */
function searchTerms(brandId) {
  const b = brand(brandId);
  return b.aliases.map(a => `"${a}"`);
}

module.exports = {
  config,
  brand,
  allBrands,
  brandOrder,
  eventConfig,
  matchBrand,
  matchAllBrands,
  searchTerms,
  CONFIG_PATH,
};
