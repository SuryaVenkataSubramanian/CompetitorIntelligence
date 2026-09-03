#!/usr/bin/env node
/**
 * "How to rank" — Document360-only recommendations WITH the finished asset.
 *
 *   node collectors/claude/rank-assets.js build   → store/pending-rank-assets.json
 *   node collectors/claude/rank-assets.js apply   → validates → data/rank-assets.json
 *
 * WHAT MAKES THIS DIFFERENT FROM A GENERIC CONTENT SUGGESTION
 * ----------------------------------------------------------
 * The queue handed to Claude contains, for one specific prompt Document360 does
 * NOT rank for:
 *
 *   · the competitors that DO rank, with their exact positions
 *   · the exact domains cited, classified (review directory / vendor page /
 *     community thread / editorial), each with its ranking URL
 *   · which of those sources name a competitor and omit Document360
 *
 * Claude then writes a complete asset — the actual LinkedIn copy, the actual
 * Reddit post, the actual blog draft — and must cite which of those supplied
 * evidence URLs drove it.
 *
 * `apply` enforces three gates mechanically, and a failing asset is DROPPED
 * rather than published with a warning:
 *
 *   1 GROUNDING     every evidence_url cited must be one supplied in the queue.
 *                   A URL Claude introduced itself cannot be verified, so it is
 *                   rejected — this is the anti-hallucination gate.
 *   2 COMPLETENESS  the asset must carry the fields its own channel needs. A
 *                   "LinkedIn post" with no body is a suggestion, not an asset,
 *                   and the requirement was to produce the asset.
 *   3 SCOPE         Document360 only. An asset whose subject is a competitor is
 *                   rejected, because the requirement is explicit about focus.
 */
const path = require("path");
const fs = require("fs");
const { readJson, writeJson, STORE_DIR } = require("../lib/store");
const citations = require("../lib/ai-citations");
const aiHistory = require("../lib/ai-history");
const { brand } = require("../lib/brands");

const QUEUE = path.join(STORE_DIR, "pending-rank-assets.json");
const ANSWERS = path.join(STORE_DIR, "claude-rank-assets.json");
const OUT = path.join(__dirname, "..", "..", "data", "rank-assets.json");

const TARGET = "document360";

/**
 * Required fields per asset type. This table IS the definition of "actually
 * produced the asset" — anything not listed here cannot be validated and so
 * cannot be accepted.
 */
const ASSET_SPEC = {
  linkedin_post: {
    label: "LinkedIn post",
    required: ["body"],
    min: { body: 400 },
    note: "Complete post copy, ready to publish.",
  },
  linkedin_influencer: {
    label: "LinkedIn influencer collaboration",
    required: ["body", "outreach_message"],
    min: { body: 300, outreach_message: 200 },
    note: "Post copy plus the actual outreach message.",
  },
  youtube_video: {
    label: "YouTube video",
    required: ["title", "description", "outline"],
    min: { description: 300 },
    minItems: { outline: 4 },
    note: "Title, description and a section-by-section script outline.",
  },
  reddit_post: {
    label: "Reddit / community post",
    required: ["subreddit", "title", "body"],
    min: { body: 400 },
    note: "Complete post, written as a practitioner rather than a vendor.",
  },
  blog: {
    label: "Blog article",
    required: ["title", "outline", "draft"],
    min: { draft: 800 },
    minItems: { outline: 4 },
    note: "Title, full outline and a substantive draft.",
  },
  comparison_page: {
    label: "Comparison page",
    required: ["title", "structure", "copy"],
    min: { copy: 600 },
    minItems: { structure: 4 },
    note: "Page structure plus the actual copy.",
  },
  landing_page: {
    label: "Landing page",
    required: ["title", "structure", "copy"],
    min: { copy: 500 },
    minItems: { structure: 4 },
    note: "Section structure plus headline and body copy.",
  },
  docs_page: {
    label: "Documentation / resource page",
    required: ["title", "outline", "copy"],
    min: { copy: 400 },
    minItems: { outline: 3 },
    note: "A public docs or resource page that an AI crawler can cite.",
  },
  case_study: {
    label: "Case study",
    required: ["title", "structure", "copy"],
    min: { copy: 500 },
    minItems: { structure: 3 },
    note: "Structure plus copy. Any metric must be marked as a placeholder unless supplied by evidence.",
  },
  seo_entity: {
    label: "SEO / AI-visibility play",
    required: ["target_keywords", "target_entities", "citation_strategy"],
    minItems: { target_keywords: 3, target_entities: 3 },
    min: { citation_strategy: 300 },
    note: "Keywords, entities and the specific citation strategy.",
  },
};

/* -------------------------------------------------------------------- build */

function build({ since = null, maxPrompts = 12 } = {}) {
  const gaps = aiHistory.gaps(TARGET, { since });
  const rows = citations.analyse(TARGET, { since });

  // Only prompts where the check succeeded and Document360 is genuinely absent.
  const absent = rows.filter(r => !r.appears);
  if (!absent.length) {
    return {
      ok: false,
      error:
        "No measured prompt currently shows Document360 as absent. Either nothing has been probed yet " +
        "(run a prompt search in AI Visibility) or Document360 ranks for everything probed so far.",
      probed_prompts: rows.length,
    };
  }

  const items = absent.slice(0, maxPrompts).map(r => ({
    prompt: r.prompt,
    provider: r.provider,
    probed_at: r.probed_at,

    document360_status: "absent from the measured result set for this prompt",

    // Everything below is fetched evidence. Claude may use ONLY these URLs.
    competitors_ranking: r.competitors.map(c => ({
      name: c.name,
      position: c.position,
      evidence_url: c.evidence_url,
      own_domain_ranks_at: c.own_domain_rank,
    })),
    citing_sources: (r.content_gaps || []).map(g => ({
      rank: g.rank,
      domain: g.domain,
      url: g.url,
      title: g.title,
      source_type: g.source_type,
      names: g.carries,
      why_winnable: g.opportunity,
    })),
    all_ranked_domains: (r.my_sources || []).concat(r.content_gaps || [])
      .map(s => ({ rank: s.rank, domain: s.domain, url: s.url })),
  }));

  const allowedUrls = [...new Set(
    items.flatMap(i => [
      ...i.competitors_ranking.map(c => c.evidence_url),
      ...i.citing_sources.map(s => s.url),
      ...i.all_ranked_domains.map(d => d.url),
    ]).filter(Boolean)
  )];

  writeJson(QUEUE, {
    built_at: new Date().toISOString(),
    target_brand: brand(TARGET).name,
    prompt_count: items.length,
    asset_types: Object.fromEntries(
      Object.entries(ASSET_SPEC).map(([k, v]) => [k, { label: v.label, required: v.required, note: v.note }])
    ),
    allowed_evidence_urls: allowedUrls,
    items,
    instructions: {
      task:
        "For EACH item below, Document360 does not appear in the measured AI/search result for that buyer " +
        "prompt, while the listed competitors do. Produce 1-3 recommendations per item that would plausibly " +
        "change that — and for each one, WRITE THE COMPLETE ASSET, not a description of it.",
      output_shape:
        '{"recommendations":[{"prompt":"<verbatim from item>","asset_type":"<one key of asset_types>",' +
        '"title":"<short action title>","why":"<2-3 sentences on why this improves Document360 visibility ' +
        'for this prompt>","evidence_urls":["<url from allowed_evidence_urls>"],' +
        '"asset":{ <the fields required for that asset_type> },"effort":"low|medium|high",' +
        '"owner":"Content|Product|Marketing|Developer Relations|SEO"}]}',
      hard_rules: [
        "SCOPE: every recommendation must be an action for Document360. Never write an asset promoting a competitor.",
        "GROUNDING: every URL in evidence_urls MUST come from allowed_evidence_urls. Any other URL causes the recommendation to be rejected outright. Do not cite a source you were not given.",
        "COMPLETENESS: fill every field listed in asset_types[asset_type].required, meeting the length minimums. A short stub is rejected.",
        "NO INVENTED FACTS: do not state customer counts, award placements, review scores, pricing or benchmark numbers. If a case study needs a metric, write it as [METRIC TO CONFIRM] rather than a plausible-looking number.",
        "The `why` must refer to the actual competitor or source in that item — a reason that would read identically for any prompt is a generic recommendation and the requirement forbids those.",
        "Write in Document360's voice: practical, specific, no hype adjectives.",
      ],
    },
  });

  return { ok: true, prompts: items.length, allowed_urls: allowedUrls.length, queue: QUEUE };
}

/* -------------------------------------------------------------------- apply */

function len(v) {
  if (v == null) return 0;
  if (Array.isArray(v)) return v.length;
  return String(v).length;
}

/** Does this asset carry everything its channel needs? */
function checkCompleteness(assetType, asset) {
  const spec = ASSET_SPEC[assetType];
  if (!spec) return { ok: false, reason: `unknown asset_type "${assetType}"` };
  if (!asset || typeof asset !== "object") return { ok: false, reason: "asset object missing" };

  for (const f of spec.required) {
    if (asset[f] == null || (typeof asset[f] === "string" && !asset[f].trim())) {
      return { ok: false, reason: `asset.${f} is missing — a ${spec.label} without ${f} is a suggestion, not an asset` };
    }
  }
  for (const [f, min] of Object.entries(spec.min || {})) {
    if (len(asset[f]) < min) {
      return { ok: false, reason: `asset.${f} is ${len(asset[f])} chars, needs >= ${min}` };
    }
  }
  for (const [f, min] of Object.entries(spec.minItems || {})) {
    if (!Array.isArray(asset[f]) || asset[f].length < min) {
      return { ok: false, reason: `asset.${f} needs >= ${min} items, has ${Array.isArray(asset[f]) ? asset[f].length : 0}` };
    }
  }
  return { ok: true };
}

/**
 * Patterns that indicate a fabricated specific. Numbers are legitimate in
 * general prose, so this targets the shapes that assert an unverifiable
 * competitive fact — the kind a reader would repeat as true.
 */
const FABRICATION = [
  { re: /\brated (?:the )?(?:number one|#1|no\.?\s?1)\b/i, why: "asserts a ranking award" },
  { re: /\bG2\s+(?:score|rating)\s+of\s+[\d.]+/i, why: "asserts a specific G2 score" },
  { re: /\b\d{2,3}%\s+(?:of\s+)?(?:customers|users|companies)\b/i, why: "asserts a customer statistic" },
  { re: /\b(?:Gartner|Forrester)\s+(?:named|ranked|placed)\b/i, why: "asserts analyst recognition" },
  { re: /\b\d[\d,]{2,}\+?\s+(?:customers|companies|teams)\s+(?:use|trust)\b/i, why: "asserts a customer count" },
  { re: /\baward[- ]winning\b/i, why: "asserts an award" },
];

function scanFabrication(text) {
  const hits = [];
  for (const f of FABRICATION) {
    const m = String(text).match(f.re);
    if (m) hits.push({ matched: m[0], why: f.why });
  }
  return hits;
}

function apply() {
  const queue = readJson(QUEUE, null);
  if (!queue) return { ok: false, error: `no queue at ${QUEUE} — run build first` };
  const file = readJson(ANSWERS, null);
  if (!file) return { ok: false, error: `no answers at ${ANSWERS}` };

  const recs = Array.isArray(file) ? file : file.recommendations || [];
  const allowed = new Set(queue.allowed_evidence_urls || []);
  const prompts = new Set((queue.items || []).map(i => i.prompt));
  const byPrompt = new Map((queue.items || []).map(i => [i.prompt, i]));

  const audit = {
    submitted: recs.length,
    accepted: 0,
    rejected: 0,
    rejections: [],
    checks: {
      unknown_prompt: 0,
      ungrounded_url: 0,
      incomplete_asset: 0,
      out_of_scope: 0,
      fabrication: 0,
      generic_why: 0,
    },
  };

  const accepted = [];

  for (const r of recs) {
    const reject = (reason, check) => {
      audit.rejected++;
      audit.checks[check] = (audit.checks[check] || 0) + 1;
      audit.rejections.push({ title: r && r.title, prompt: r && r.prompt, reason, check });
    };

    if (!r || !r.prompt || !r.asset_type) { reject("missing prompt or asset_type", "unknown_prompt"); continue; }

    // GATE 1a — the prompt must be one we actually probed.
    if (!prompts.has(r.prompt)) {
      reject(`prompt not in the queue: "${String(r.prompt).slice(0, 70)}"`, "unknown_prompt");
      continue;
    }

    // GATE 1b — grounding. Every cited URL must have been supplied.
    const urls = Array.isArray(r.evidence_urls) ? r.evidence_urls : [];
    if (!urls.length) { reject("cites no evidence", "ungrounded_url"); continue; }
    const bad = urls.filter(u => !allowed.has(u));
    if (bad.length) {
      reject(`cites ${bad.length} URL(s) that were not supplied as evidence: ${bad.slice(0, 2).join(", ")}`, "ungrounded_url");
      continue;
    }

    // GATE 2 — completeness.
    const comp = checkCompleteness(r.asset_type, r.asset);
    if (!comp.ok) { reject(comp.reason, "incomplete_asset"); continue; }

    // GATE 3 — scope. The asset must be about Document360.
    const blob = JSON.stringify(r.asset) + " " + (r.title || "") + " " + (r.why || "");
    if (!/document\s?360/i.test(blob)) {
      reject("asset never mentions Document360 — recommendations must be Document360-only", "out_of_scope");
      continue;
    }

    // GATE 4 — no fabricated competitive specifics.
    const fab = scanFabrication(blob);
    if (fab.length) {
      reject(`contains an unverifiable claim (${fab[0].why}: "${fab[0].matched}")`, "fabrication");
      continue;
    }

    // GATE 5 — the `why` must be specific to this prompt's evidence.
    const item = byPrompt.get(r.prompt);
    const namedCompetitors = (item.competitors_ranking || []).map(c => c.name);
    const namedDomains = (item.citing_sources || []).map(s => s.domain).filter(Boolean);
    const whyText = String(r.why || "");
    const referencesEvidence =
      namedCompetitors.some(n => whyText.toLowerCase().includes(n.toLowerCase())) ||
      namedDomains.some(d => whyText.toLowerCase().includes(String(d).toLowerCase()));
    if (whyText.length < 80 || !referencesEvidence) {
      reject(
        "the rationale does not name any competitor or source from this prompt's evidence, so it is generic",
        "generic_why"
      );
      continue;
    }

    audit.accepted++;
    accepted.push({
      prompt: r.prompt,
      provider: item.provider,
      asset_type: r.asset_type,
      asset_label: ASSET_SPEC[r.asset_type].label,
      title: r.title || ASSET_SPEC[r.asset_type].label,
      why: whyText,
      effort: ["low", "medium", "high"].includes(r.effort) ? r.effort : null,
      owner: r.owner || null,
      asset: r.asset,
      // Resolve each cited URL back to its ranked source, so the UI can show
      // the evidence rather than a bare link.
      evidence: urls.map(u => {
        const src = (item.citing_sources || []).find(s => s.url === u);
        const comp2 = (item.competitors_ranking || []).find(c => c.evidence_url === u);
        return {
          url: u,
          domain: src ? src.domain : null,
          title: src ? src.title : null,
          rank: src ? src.rank : (comp2 ? comp2.position : null),
          source_type: src ? src.source_type : null,
          names: src ? src.names : (comp2 ? [comp2.name] : []),
        };
      }),
      competitors_ranking: item.competitors_ranking,
      generated_at: new Date().toISOString(),
      verification: "claude-generated asset, grounded in fetched ranked sources; every cited URL machine-verified against the evidence supplied",
    });
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    generated_at: new Date().toISOString(),
    target_brand: brand(TARGET).name,
    method:
      "For each buyer prompt where Document360 was measured as absent, Claude was given the competitors " +
      "that ranked, their positions, and every citing domain with its URL — then asked to write the finished " +
      "asset. Each result passed five mechanical gates: prompt known, every cited URL supplied as evidence, " +
      "channel-required fields present and long enough, Document360-scoped, and no unverifiable claim.",
    audit,
    asset_spec: Object.fromEntries(Object.entries(ASSET_SPEC).map(([k, v]) => [k, v.label])),
    recommendations: accepted,
  }, null, 2));

  return { ok: true, ...audit, out: OUT };
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === "build") {
    const r = build();
    if (!r.ok) { console.error("  ! " + r.error); process.exit(1); }
    console.log(`\nQueued ${r.prompts} prompt(s) where Document360 does not rank`);
    console.log(`  ${r.allowed_urls} evidence URL(s) whitelisted`);
    console.log(`  → ${r.queue}`);
    console.log(`\nClaude Code writes {"recommendations":[…]} to`);
    console.log(`  collectors/store/claude-rank-assets.json, then:`);
    console.log(`  node collectors/claude/rank-assets.js apply\n`);
  } else if (cmd === "apply") {
    const r = apply();
    if (!r.ok) { console.error("  ! " + r.error); process.exit(1); }
    console.log(`\nRank assets: ${r.accepted} accepted, ${r.rejected} rejected of ${r.submitted}`);
    for (const [k, v] of Object.entries(r.checks)) if (v) console.log(`  ${k}: ${v}`);
    for (const rej of r.rejections.slice(0, 8)) console.log(`  ! ${String(rej.title || "").slice(0, 50)} — ${rej.reason}`);
    console.log(`  → ${r.out}\n`);
  } else {
    console.log("usage: node collectors/claude/rank-assets.js build | apply");
  }
}

module.exports = { build, apply, ASSET_SPEC, QUEUE, ANSWERS, OUT, scanFabrication, checkCompleteness };
