/**
 * AI Citation Analysis (requirement 2).
 *
 * For every probed prompt, answers: does the brand appear, at what rank, which
 * sources support the result, which competitors appear, which sources those
 * competitors are cited from, and where the content gap is.
 *
 * EVERY FINDING CARRIES ITS SOURCE. A "content gap" here is not an opinion — it
 * is a named domain that ranks for a prompt where Document360 does not, with the
 * URL attached. If a claim cannot be tied to a fetched, ranked URL it is not
 * emitted at all.
 */
const { brandOrder, brand, allBrands } = require("./brands");
const history = require("./ai-history");

/** Domains that are review directories rather than vendor content. */
const DIRECTORY = /^(g2|capterra|getapp|trustradius|softwareadvice|sourceforge|slashdot|saasworthy|softwaresuggest|crozdesk|producthunt|gartner|trustpilot)\./i;

/** A domain owned by one of the tracked products. */
function brandDomain(domain) {
  if (!domain) return null;
  const b = allBrands().find(x => x.domain && domain.endsWith(x.domain));
  return b ? b.id : null;
}

function classifySource(domain) {
  if (!domain) return "unknown";
  if (DIRECTORY.test(domain)) return "review_directory";
  const owned = brandDomain(domain);
  if (owned) return "vendor_owned";
  if (/^(reddit|news\.ycombinator|quora|stackoverflow|stackexchange)\./.test(domain)) return "community";
  if (/^(youtube|youtu)\./.test(domain)) return "video";
  if (/^(linkedin)\./.test(domain)) return "social";
  if (/^(medium|dev\.to|substack|hashnode)\./.test(domain)) return "syndicated_blog";
  if (/^(en\.wikipedia|wikipedia)\./.test(domain)) return "reference";
  return "editorial";
}

/**
 * Per-prompt citation analysis for one brand.
 * Only prompts with a MEASURED provider result are analysed; an unchecked
 * provider produces no row rather than an empty-looking one.
 */
function analyse(brandId, { since = null } = {}) {
  const h = history.readHistory();
  const cutoff = since ? new Date(since).getTime() : null;
  const rows = [];

  for (const e of h.entries) {
    if (cutoff && new Date(e.probed_at).getTime() < cutoff) continue;

    for (const [providerId, p] of Object.entries(e.providers || {})) {
      if (p.status !== "measured") continue;

      const me = (p.brands || {})[brandId] || { visible: false, position: null };
      const citations = p.citations || [];

      const competitors = Object.entries(p.brands || {})
        .filter(([id, v]) => id !== brandId && v.visible)
        .map(([id, v]) => ({
          brand_id: id,
          name: brand(id) ? brand(id).name : id,
          position: v.position,
          evidence: v.evidence || null,
          evidence_url: v.evidence_url || null,
          own_domain_rank: v.own_domain_rank ?? null,
        }))
        .sort((a, c) => (a.position || 99) - (c.position || 99));

      // Which specific sources carry each competitor. This is the actionable
      // half of the analysis: it names the publications to target.
      const competitorSources = {};
      for (const c of citations) {
        for (const mentioned of c.mentions || []) {
          if (mentioned === brandId) continue;
          (competitorSources[mentioned] = competitorSources[mentioned] || []).push({
            rank: c.rank, domain: c.domain, domain_unresolved: !!c.domain_unresolved, url: c.url, title: c.title,
            source_type: classifySource(c.domain),
          });
        }
      }

      // Sources supporting OUR appearance, where we appear at all.
      const mySources = citations
        .filter(c => (c.mentions || []).includes(brandId))
        .map(c => ({ rank: c.rank, domain: c.domain, domain_unresolved: !!c.domain_unresolved, url: c.url, title: c.title, source_type: classifySource(c.domain) }));

      /* ------------------------------------------------------ content gaps */
      // A gap is a ranking source that mentions a competitor and NOT us. Each
      // one is a concrete, checkable opportunity rather than a generic idea.
      const gapSources = citations
        .filter(c => {
          const m = c.mentions || [];
          return m.length && !m.includes(brandId);
        })
        .map(c => ({
          rank: c.rank,
          domain: c.domain,
          domain_unresolved: !!c.domain_unresolved,
          url: c.url,
          title: c.title,
          source_type: classifySource(c.domain),
          carries: (c.mentions || []).map(id => (brand(id) ? brand(id).name : id)),
          // Why this specific source is worth pursuing.
          opportunity:
            classifySource(c.domain) === "review_directory"
              ? "Review-directory listing: a profile and review volume here is directly winnable."
              : classifySource(c.domain) === "vendor_owned"
                ? "A competitor's own page ranks for this buyer prompt — a comparison page of our own can contest it."
                : classifySource(c.domain) === "community"
                  ? "Community thread: an authentic practitioner answer is the accepted format here."
                  : "Editorial page ranking for this prompt without naming us — a placement or outreach target.",
        }));

      rows.push({
        prompt: e.prompt,
        provider: providerId,
        probed_at: e.probed_at,
        entry_id: e.id,

        appears: !!me.visible,
        position: me.position ?? null,
        own_domain_rank: me.own_domain_rank ?? null,
        evidence: me.evidence || null,
        evidence_url: me.evidence_url || null,

        competitors,
        competitor_sources: competitorSources,
        my_sources: mySources,
        content_gaps: gapSources,

        total_citations: citations.length,
        confidence: p.confidence ?? null,
        method: p.method || null,
      });
    }
  }

  return rows;
}

/**
 * Which domains dominate this prompt set overall, and do they mention us?
 * The single most useful roll-up: it names the publications that decide AI
 * answers in this category and shows which ones omit us.
 */
function domainAuthority(brandId, { since = null } = {}) {
  const rows = analyse(brandId, { since });
  const byDomain = {};

  for (const r of rows) {
    const all = [...r.my_sources, ...Object.values(r.competitor_sources).flat(), ...r.content_gaps];
    for (const s of all) {
      // A redirect wrapper is not a publisher. Gemini cites everything through
      // vertexaisearch.cloud.google.com, which made that host appear as the 3rd
      // most authoritative domain in the category — it is Google's redirector.
      if (!s.domain || s.domain_unresolved) continue;
      if (/^(vertexaisearch\.cloud\.google\.com|news\.google\.com|t\.co)$/i.test(s.domain)) continue;
      const d = (byDomain[s.domain] = byDomain[s.domain] || {
        domain: s.domain,
        source_type: s.source_type,
        times_ranked: 0,
        best_rank: 999,
        mentions_us: 0,
        mentions_competitors: 0,
        example_url: s.url,
        prompts: new Set(),
      });
      d.times_ranked++;
      d.best_rank = Math.min(d.best_rank, s.rank || 999);
      d.prompts.add(r.prompt);
      if (r.my_sources.some(x => x.url === s.url)) d.mentions_us++;
      if (s.carries || Object.values(r.competitor_sources).flat().some(x => x.url === s.url)) d.mentions_competitors++;
    }
  }

  return Object.values(byDomain)
    .map(d => ({ ...d, prompts: d.prompts.size, best_rank: d.best_rank === 999 ? null : d.best_rank }))
    .sort((a, b) => b.times_ranked - a.times_ranked);
}

module.exports = { analyse, domainAuthority, classifySource };
