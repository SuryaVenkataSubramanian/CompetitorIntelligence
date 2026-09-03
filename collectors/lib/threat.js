/**
 * Competitive classification and threat scoring for a discovered entrant.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: "Do not classify based on keywords
 * alone. Require evidence."
 *
 * So no signal here fires on the search keyword that surfaced a product. Every
 * signal must match text the product publishes about ITSELF — its title, meta
 * description, or homepage body, all of which were fetched and hashed by
 * lib/fetch.js. Each signal records the phrase it matched and where, so a score
 * of 74 can be taken apart and disputed rather than merely trusted.
 *
 * A signal that cannot cite a matched phrase contributes zero.
 */

/**
 * Document360's own footprint, used as the yardstick. Overlap is measured
 * against these capability groups rather than against a vague notion of
 * "documentation", because that is what makes "why it could compete" concrete.
 */
const CORE = {
  // The same product category. Overlap here is what makes something direct.
  category: {
    weight: 30,
    label: "Same product category as Document360",
    patterns: [
      /\bknowledge ?base\b/i,
      /\bdocumentation (?:platform|software|tool|system)\b/i,
      /\bhelp ?cent(?:er|re)\b/i,
      /\bdocs platform\b/i,
      /\bproduct documentation\b/i,
      /\btechnical documentation\b/i,
      /\bknowledge management (?:platform|software|system)\b/i,
      /\bself-?service (?:portal|support|knowledge)\b/i,

      /* Developer- and API-documentation products belong in this category, not
       * an adjacent one. Two of the seven tracked competitors — Mintlify and
       * GitBook — compete here directly.
       *
       * Measured: buildwithfern.com describes itself as "Docs, SDKs, and CLIs
       * for your API" offering "interactive API documentation", and the earlier
       * pattern set scored it not_a_competitor because none of the phrases above
       * matched. It is squarely a competitor in the same segment as Mintlify. */
      /\bAPI documentation\b/i,
      /\bAPI docs\b/i,
      /\bdeveloper documentation\b/i,
      /\bdeveloper (?:portal|hub)\b/i,
      /\bdocs for your API\b/i,
      /\b(?:docs|documentation)(?:,| and)[^.]{0,40}\bfor your API\b/i,
      /\bOpenAPI\b/,
      /\bAPI reference\b/i,
    ],
  },
  // Where the market is moving, and where Document360 invests (Eddy).
  ai_native: {
    weight: 20,
    label: "AI-native capability",
    patterns: [
      /\bAI[- ](?:powered|native|driven|first)\b/i,
      /\bAI (?:assistant|agent|search|answers?|chatbot)\b/i,
      /\bask (?:your|the) docs\b/i,
      /\bsemantic search\b/i,
      /\bRAG\b/,
      /\bLLM\b/,
      /\bgenerative AI\b/i,
      /\bMCP (?:server|endpoint)\b/i,
      /\bllms?\.txt\b/i,
    ],
  },
  // Features Document360 competes on directly in enterprise deals.
  enterprise_overlap: {
    weight: 20,
    label: "Overlaps Document360's differentiating features",
    patterns: [
      /\bversion(?:ing|s|\s+control|\s+history)\b/i,
      /\bapproval workflow\b/i,
      /\breview workflow\b/i,
      /\baudit (?:trail|log)\b/i,
      /\brole-?based access\b/i,
      /\bSSO\b/,
      /\bSAML\b/,
      /\blocali[sz]ation\b/i,
      /\bmultilingual\b/i,
      // API documentation moved to CORE.category, where it belongs. Leaving it
      // here as well would double-count the same phrase across two groups.
      /\banalytics\b/i,
      /\bcategory manager\b/i,
      /\bcontent reuse\b/i,
    ],
  },
  // Is it a real, buyable product or a landing page?
  commercial: {
    weight: 15,
    label: "Commercially ready",
    patterns: [
      /\bpricing\b/i,
      /\bfree trial\b/i,
      /\bstart free\b/i,
      /\bbook a demo\b/i,
      /\brequest a demo\b/i,
      /\bper (?:user|seat|month)\b/i,
      /\bcustomers?\b/i,
      /\btrusted by\b/i,
      /\bcase stud(?:y|ies)\b/i,
      /\bSOC ?2\b/i,
      /\bGDPR\b/,
    ],
  },
  // Momentum: recent arrival or active funding, which raises urgency.
  momentum: {
    weight: 15,
    label: "Recent launch or active momentum",
    patterns: [
      /\bnow (?:in )?(?:public )?beta\b/i,
      /\bjoin the waitlist\b/i,
      /\bearly access\b/i,
      /\bjust launched\b/i,
      /\bnewly launched\b/i,
      /\blaunching (?:soon|this)\b/i,
      /\bproduct hunt\b/i,
      /\bY ?Combinator\b/i,
      /\b(?:seed|series [a-c]|pre-seed) (?:round|funding)\b/i,
      /\braised \$[\d.]+ ?[mkb]/i,
      /\bbacked by\b/i,
      /\bchangelog\b/i,
      /\bwhat'?s new\b/i,
    ],
  },
};

/**
 * Adjacent categories: genuinely overlapping buyer conversations, but not the
 * same product. Presence here without CORE.category is what "adjacent" means.
 */
const ADJACENT = {
  weight: 18,
  label: "Adjacent category that competes for the same budget",
  patterns: [
    /\bSOP\b/,
    /\bstandard operating procedure\b/i,
    /\bprocess documentation\b/i,
    /\bvideo to (?:docs|documentation|SOP)\b/i,
    /\bscreen recording\b/i,
    /\bonboarding (?:docs|documentation|guides?)\b/i,
    /\btraining (?:content|material|docs)\b/i,
    /\bwiki\b/i,
    /\binternal (?:docs|documentation|wiki)\b/i,
    /\bdeveloper portal\b/i,
    /\bAPI (?:docs|reference) generator\b/i,
    /\btechnical writing\b/i,
    /\bcustomer support (?:automation|deflection)\b/i,
    /\bticket deflection\b/i,
  ],
};

/** Categories that are simply a different business. */
const DISQUALIFY = {
  label: "Different product category",
  patterns: [
    /\be-?signature\b/i, /\bcontract (?:management|lifecycle)\b/i,
    /\binvoic(?:e|ing)\b/i, /\bpayroll\b/i, /\bapplicant tracking\b/i,
    /\bpassword manager\b/i, /\bVPN\b/, /\bantivirus\b/i,
    /\be-?commerce (?:platform|store)\b/i, /\baccounting software\b/i,
    /\bproject management (?:tool|software)\b/i,
    /\breview (?:site|directory|platform) for\b/i,
    /\bcompare \d+\+? (?:tools|products|vendors)\b/i,
  ],
};

/**
 * Score one text field group. `identity` (title + meta description) counts for
 * more than `body`, because what a product says it IS in its own title is
 * stronger evidence than a word appearing somewhere on the page.
 */
function matchGroup(group, identity, body) {
  const hits = [];
  for (const re of group.patterns) {
    const mi = identity.match(re);
    if (mi) { hits.push({ matched: mi[0], where: "title/description" }); continue; }
    const mb = body.match(re);
    if (mb) hits.push({ matched: mb[0], where: "homepage body" });
  }
  if (!hits.length) return { score: 0, hits: [] };

  // Diminishing returns: the first match is most of the signal, further matches
  // add confirmation. Without this, a page repeating "AI" ten times would
  // outscore a genuinely broader competitor.
  const inIdentity = hits.some(h => h.where === "title/description");
  const depth = Math.min(1, 0.55 + 0.15 * (hits.length - 1));
  const placement = inIdentity ? 1 : 0.7;
  return {
    score: Math.round(group.weight * depth * placement),
    hits: hits.slice(0, 6),
  };
}

/**
 * Classify and score an entrant.
 *
 * @param entrant  a verified discovery record: needs `identity` (title + meta
 *                 description), `body_text` (fetched homepage text), plus the
 *                 discovery metadata used only for reporting, never for scoring.
 */
function assess(entrant) {
  const identity = String(entrant.identity || "").slice(0, 2000);
  const body = String(entrant.body_text || "").slice(0, 20000);

  const signals = [];
  const add = (key, group, result) => {
    if (!result.score) return;
    signals.push({
      id: key,
      label: group.label,
      contributed: result.score,
      of_max: group.weight,
      // The phrases that earned the points, and where they were found.
      evidence: result.hits,
    });
  };

  const cat = matchGroup(CORE.category, identity, body);
  const ai = matchGroup(CORE.ai_native, identity, body);
  const ent = matchGroup(CORE.enterprise_overlap, identity, body);
  const com = matchGroup(CORE.commercial, identity, body);
  const mom = matchGroup(CORE.momentum, identity, body);
  const adj = matchGroup(ADJACENT, identity, body);
  const dis = matchGroup(DISQUALIFY, identity, body);

  add("category", CORE.category, cat);
  add("ai_native", CORE.ai_native, ai);
  add("enterprise_overlap", CORE.enterprise_overlap, ent);
  add("commercial", CORE.commercial, com);
  add("momentum", CORE.momentum, mom);
  if (!cat.score) add("adjacent", ADJACENT, adj);

  /* ------------------------------------------------------- classification */
  // Disqualification wins outright, but only when the product does NOT also
  // describe itself in our category — a docs platform mentioning e-signature as
  // an integration is still a docs platform.
  const disqualified = dis.score > 0 && !cat.score;

  let classification, basis;
  if (disqualified) {
    classification = "not_a_competitor";
    basis = `Its own description places it in a different category (matched "${dis.hits[0].matched}" in ${dis.hits[0].where}) and it never describes itself as a documentation or knowledge-base product.`;
  } else if (!cat.score && !adj.score) {
    classification = "not_a_competitor";
    basis = "Its own title, description and homepage never place it in this category or an adjacent one.";
  } else if (cat.score && com.score && !isEarlyStage(mom, com)) {
    classification = "direct_competitor";
    basis = `Describes itself in Document360's own category (matched "${cat.hits[0].matched}" in ${cat.hits[0].where}) and is commercially available (matched "${com.hits[0].matched}").`;
  } else if (cat.score && isEarlyStage(mom, com)) {
    classification = "emerging_competitor";
    basis = `Same category as Document360 (matched "${cat.hits[0].matched}"), but still early — ${mom.hits.length ? `matched "${mom.hits[0].matched}"` : "no pricing or trial published yet"}.`;
  } else if (cat.score) {
    classification = "emerging_competitor";
    basis = `Same category (matched "${cat.hits[0].matched}") but publishes no pricing, trial or demo, so it is not yet commercially contesting deals.`;
  } else {
    classification = "adjacent_competitor";
    basis = `Not a documentation platform, but competes for the same budget and buyer conversation (matched "${adj.hits[0].matched}" in ${adj.hits[0].where}).`;
  }

  /* --------------------------------------------------------- threat score */
  let score = signals.reduce((a, s) => a + s.contributed, 0);
  // A product outside the category cannot be a top-tier threat regardless of how
  // many secondary signals it shows.
  if (classification === "adjacent_competitor") score = Math.min(score, 55);
  if (classification === "not_a_competitor") score = Math.min(score, 15);
  score = Math.max(0, Math.min(100, score));

  /* ---------------------------------------------------- why it could compete */
  // Built from the signals that actually fired, so it can never be generic.
  const why = buildWhy(classification, { cat, ai, ent, com, mom, adj });

  return {
    classification,
    classification_basis: basis,
    threat_score: score,
    threat_band: score >= 70 ? "high" : score >= 40 ? "medium" : score >= 20 ? "low" : "minimal",
    why_it_could_compete: why,
    signals,
    // Confidence in the ASSESSMENT (distinct from confidence that the product
    // exists). Driven by how much of the judgement came from the product's own
    // identity rather than incidental body text.
    assessment_confidence: assessmentConfidence(identity, body, signals),
    assessed_at: new Date().toISOString(),
    method:
      "Scored only on phrases the product publishes about itself (title, meta description, homepage body), " +
      "never on the search keyword that surfaced it. Each signal records its matched phrase and location.",
  };
}

/** Early-stage means momentum signals without commercial readiness. */
function isEarlyStage(mom, com) {
  const earlyPhrases = mom.hits.filter(h =>
    /waitlist|early access|beta|just launched|newly launched|launching/i.test(h.matched)
  );
  const hasPricing = com.hits.some(h => /pricing|per (?:user|seat|month)|free trial|start free/i.test(h.matched));
  return earlyPhrases.length > 0 && !hasPricing;
}

function buildWhy(classification, g) {
  const parts = [];
  if (g.cat.score) {
    parts.push(`It positions itself in the same category as Document360 — its own page says "${g.cat.hits[0].matched}".`);
  } else if (g.adj.score) {
    parts.push(`It sells into an adjacent problem ("${g.adj.hits[0].matched}") that overlaps Document360's buyer.`);
  }
  if (g.ai.score) {
    parts.push(`It leads with AI capability ("${g.ai.hits[0].matched}"), competing on the same ground as Eddy.`);
  }
  if (g.ent.score) {
    const feats = [...new Set(g.ent.hits.map(h => h.matched.toLowerCase()))].slice(0, 4);
    parts.push(`It claims ${feats.join(", ")} — features Document360 competes on in enterprise evaluations.`);
  }
  if (g.mom.score) {
    parts.push(`Momentum signal: "${g.mom.hits[0].matched}".`);
  }
  if (g.com.score && classification === "direct_competitor") {
    parts.push(`It is buyable today ("${g.com.hits[0].matched}"), so it can appear in live deals.`);
  }
  if (!parts.length) {
    return "No evidence on its own site supports it competing with Document360.";
  }
  return parts.join(" ");
}

function assessmentConfidence(identity, body, signals) {
  if (!signals.length) return 0.3;
  const fromIdentity = signals.filter(s => s.evidence.some(e => e.where === "title/description")).length;
  let c = 0.45
    + Math.min(0.3, fromIdentity * 0.12)      // identity evidence is the strongest
    + Math.min(0.15, signals.length * 0.04);  // breadth of corroboration
  // A very thin page cannot support a confident judgement either way.
  if (body.length < 400) c -= 0.2;
  if (!identity.trim()) c -= 0.15;
  return Math.max(0.2, Math.min(0.97, Math.round(c * 100) / 100));
}

/**
 * Extract the operating company, which is often different from the product name
 * (Document360 / Kovai.co). Taken from the page's own copyright line or
 * og:site_name — never guessed from the domain.
 */
function extractCompany(html, productName) {
  const pats = [
    /©\s*(?:20\d{2}\s*[-–]?\s*(?:20\d{2})?\s*)?([A-Z][A-Za-z0-9&.,'’\- ]{2,40}?)(?:\s*[.|]|\s*All rights|\s*<)/,
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{2,60})["']/i,
    /"legalName"\s*:\s*"([^"]{2,60})"/,
    /"publisher"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]{2,60})"/,
  ];
  for (const [i, re] of pats.entries()) {
    const m = String(html).match(re);
    if (!m) continue;
    const raw = m[1].trim().replace(/\s+/g, " ").replace(/[.,]$/, "");
    if (!raw || raw.length < 2) continue;
    // A copyright line that just repeats the product name tells us nothing new.
    if (productName && raw.toLowerCase() === String(productName).toLowerCase()) {
      return { company: raw, method: "copyright line (same as product)", same_as_product: true };
    }
    return {
      company: raw,
      method: ["copyright line", "og:site_name", "schema.org legalName", "schema.org publisher"][i],
      same_as_product: false,
    };
  }
  return { company: null, method: null, same_as_product: false };
}

/**
 * Try to establish a LAUNCH date from the page, distinct from the date we first
 * saw it. Returns null rather than falling back to discovery date — the caller
 * decides how to present an unknown launch date, and conflating the two would
 * misreport a ten-year-old product as new.
 */
function extractLaunchDate(html, text) {
  const now = Date.now();
  const candidates = [];

  // A dated launch/funding announcement is the strongest evidence.
  const phrase = /(?:launched|launching|founded|established|went live|announced)\s+(?:in\s+)?((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+)?(20\d{2})/gi;
  let m;
  while ((m = phrase.exec(text)) !== null) {
    const year = parseInt(m[2], 10);
    if (year >= 2015 && year <= new Date().getFullYear()) {
      candidates.push({ date: `${year}-01-01`, precision: m[1] ? "month" : "year", basis: m[0].trim(), method: "launch phrase on page" });
    }
  }

  // schema.org foundingDate is machine-readable and unambiguous.
  const fd = String(html).match(/"foundingDate"\s*:\s*"(\d{4}(?:-\d{2}(?:-\d{2})?)?)"/);
  if (fd) candidates.push({ date: fd[1].length === 4 ? fd[1] + "-01-01" : fd[1], precision: "exact", basis: fd[1], method: "schema.org foundingDate" });

  // Reject anything in the future.
  const valid = candidates.filter(c => new Date(c.date).getTime() <= now);
  if (!valid.length) return null;
  // Prefer the most precise, then the earliest.
  const order = { exact: 0, month: 1, year: 2 };
  valid.sort((a, b) => (order[a.precision] - order[b.precision]) || a.date.localeCompare(b.date));
  return valid[0];
}

module.exports = { assess, extractCompany, extractLaunchDate, CORE, ADJACENT, DISQUALIFY };
