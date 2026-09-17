/**
 * One competitor list, from two discovery routes.
 *
 * WHY MERGE RATHER THAN SHOW TWO LISTS
 * ------------------------------------
 * Keyword discovery and the review-directory audit find different things:
 *
 *   keyword discovery   crawls a 233-term market taxonomy and fetches each
 *                       candidate's homepage. Finds products with SEO presence.
 *   directory audit     walks G2, Capterra, TrustRadius, SoftwareAdvice,
 *                       GetApp, Gartner and SoftwareSuggest across six
 *                       categories. Finds products buyers are actually shown
 *                       when they shortlist — which is a different and often
 *                       more commercially relevant population.
 *
 * A product listed on G2 under "Knowledge Base" with a homepage that scores as a
 * direct competitor IS a direct competitor. Keeping it in a separate section
 * because of how we happened to find it is an artefact of our plumbing, not a
 * fact about the market. So both routes feed one list, and each entry records
 * which route found it.
 *
 * THE BAR FOR PROMOTION
 * ---------------------
 * A directory product is promoted ONLY if its own homepage was resolved,
 * fetched and threat-assessed — the same standard every keyword-discovered
 * entrant meets. A product known only from a listing title has no homepage
 * evidence, so it cannot be classified and stays in the directory section as a
 * listing. That is why the promoted count is much smaller than the listing
 * count, and the difference is reported rather than hidden.
 *
 * "NOT A COMPETITOR" IS NOT A CATEGORY HERE
 * -----------------------------------------
 * It was a display bucket for things the assessment ruled out. A list of
 * products that are not competitors is not competitive intelligence, and it
 * pushed the real entrants down the page. Those entries are now reported as a
 * count with their reasons available, rather than as cards.
 */

const KEEP = new Set(["direct_competitor", "emerging_competitor", "adjacent_competitor"]);

/**
 * @param {object} competitors  data/competitors.json
 * @param {object} directories  data/directory-listings.json
 */
function merge(competitors, directories) {
  const base = (competitors && competitors.competitors) || [];
  const byDomain = new Map();
  const ruledOut = [];

  for (const c of base) {
    if (!KEEP.has(c.classification)) {
      ruledOut.push({
        name: c.name,
        domain: c.domain,
        classification: c.classification,
        basis: c.classification_basis,
        found_via: "keyword discovery",
      });
      continue;
    }
    byDomain.set(c.domain, Object.assign({}, c, {
      found_via: ["keyword discovery"],
      directories: [],
      directory_categories: [],
    }));
  }

  /* ---------------------------------------------- promote from directories */

  const products = (directories && directories.products) || [];
  let promoted = 0;
  let enriched = 0;
  let listingsOnly = 0;

  for (const p of products) {
    // No resolved homepage means no evidence to classify from.
    if (!p.website || !p.classification) { listingsOnly++; continue; }

    if (!KEEP.has(p.classification)) {
      ruledOut.push({
        name: p.product,
        domain: p.website ? hostOf(p.website) : null,
        classification: p.classification,
        basis: p.classification_basis,
        found_via: "review directory",
      });
      continue;
    }

    const domain = hostOf(p.website);
    if (!domain) { listingsOnly++; continue; }

    const dirIds = (p.directories || []).slice();
    const cats = (p.categories || []).map(c => c.label || c.id).filter(Boolean);

    const existing = byDomain.get(domain);
    if (existing) {
      // Found by both routes. That is corroboration, and it is worth saying so
      // explicitly rather than silently keeping one copy.
      existing.found_via = [...new Set([...existing.found_via, "review directory"])];
      existing.directories = [...new Set([...existing.directories, ...dirIds])];
      existing.directory_categories = [...new Set([...existing.directory_categories, ...cats])];
      existing.directory_listings = p.listings || [];
      existing.corroborated = true;
      enriched++;
      continue;
    }

    byDomain.set(domain, {
      name: p.product,
      name_source: p.name_source || "listing title",
      website: p.website,
      domain,
      description: p.description || null,
      description_source: p.description_note || "vendor homepage",
      company: p.company || null,
      confidence: p.confidence != null ? p.confidence : 0.6,
      category_confirmed: true,
      surfaced_by_keywords: [],
      categories: cats,
      classification: p.classification,
      classification_basis: p.classification_basis,
      threat_score: p.threat_score,
      threat_band: p.threat_band,
      why_it_could_compete: p.why_it_could_compete,
      threat_signals: p.threat_signals || [],
      assessment_confidence: p.assessment_confidence,
      first_seen: p.first_seen || null,
      times_seen: p.times_seen || 1,
      evidence_url: p.website,
      evidence_content_sha256: p.evidence_content_sha256 || null,

      found_via: ["review directory"],
      directories: dirIds,
      directory_categories: cats,
      directory_listings: p.listings || [],
      // The promotion itself is a claim, so it states its own basis.
      promotion_basis:
        "Listed on " + (dirIds.length || 0) + " review " + (dirIds.length === 1 ? "directory" : "directories") +
        " under " + (cats.join(", ") || "a tracked category") +
        ", and its own homepage was fetched and assessed as a " +
        String(p.classification).replace(/_/g, " ") + ".",
    });
    promoted++;
  }

  const list = [...byDomain.values()].sort((a, b) => (b.threat_score || 0) - (a.threat_score || 0));

  const byClassification = {};
  for (const c of list) byClassification[c.classification] = (byClassification[c.classification] || 0) + 1;

  const bySource = {
    keyword_discovery: list.filter(c => c.found_via.includes("keyword discovery") && !c.found_via.includes("review directory")).length,
    review_directory: list.filter(c => c.found_via.includes("review directory") && !c.found_via.includes("keyword discovery")).length,
    both: list.filter(c => c.found_via.length > 1).length,
  };

  return {
    competitors: list,
    by_classification: byClassification,
    by_source: bySource,
    high_threat_count: list.filter(c => (c.threat_score || 0) >= 70).length,
    promoted_from_directories: promoted,
    corroborated_by_directories: enriched,
    directory_listings_not_promoted: listingsOnly,
    ruled_out: ruledOut,
    ruled_out_count: ruledOut.length,
    merge_note:
      "One list from two routes: a 233-term keyword sweep and the review-directory audit. A directory " +
      "product is promoted here only when its own homepage was resolved, fetched and assessed — the " +
      "same bar every keyword-discovered entrant meets. " + listingsOnly + " directory listing(s) have " +
      "no resolved homepage yet and remain in the Review directories section below; resolution is " +
      "bounded per run because it costs a search per product.",
    ruled_out_note:
      ruledOut.length +
      " candidate(s) were assessed and ruled out — their own pages place them in a different category. " +
      "They are counted rather than listed: a roster of products that are not competitors is not " +
      "competitive intelligence.",
  };
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { return null; }
}

module.exports = { merge, KEEP };
