/**
 * Recommendations, grounded in verified records only.
 *
 *   node collectors/claude/recommend.js build   → store/pending-recommendations.json
 *   node collectors/claude/recommend.js apply   → validates + writes store/recommendations.json
 *
 * The old dashboard's recommendations were the least trustworthy thing in it:
 * titles auto-sliced from the first sentence of a longer field (45/45 duplicated
 * their own body text), and "evidence" that was free prose with no link back to
 * anything checkable.
 *
 * Here every recommendation MUST cite `evidence_ids` — ids of records that exist
 * in the evidence store. `apply` resolves each id; a recommendation citing an id
 * that does not exist, or citing nothing, is REJECTED. So a recommendation cannot
 * reference a competitor move that was never observed, and each one carries real
 * clickable sources into the UI.
 *
 * Claude is given a compact digest of verified signals (brand, channel, date,
 * evidence excerpt, sentiment) — never raw URLs to browse, and never the old
 * unverified snapshot.
 */
const path = require("path");
const { loadMentions, readJson, writeJson, saveRecs, STORE_DIR } = require("../lib/store");
const { isVerified } = require("../lib/record");
const { brand, brandOrder } = require("../lib/brands");

const QUEUE = path.join(STORE_DIR, "pending-recommendations.json");
const ANSWERS = path.join(STORE_DIR, "claude-rec-answers.json");

const CHANNELS_OWNERS = [
  "Product", "Product Marketing", "Growth", "Sales Enablement",
  "Partnerships", "Content/SEO", "Customer Marketing", "Competitive Intel",
];
const TYPES = ["capitalize_competitor", "accelerate_llm", "defend_position"];
const PRIORITIES = ["high", "medium", "low"];

function recordId(r) {
  return `${r.brand_id}::${r.channel}::${r.canonical_url}`;
}

/** Build a digest of the strongest verified signals, newest first. */
function build({ maxSignals = 120 } = {}) {
  const store = loadMentions();
  const verified = store.records.filter(isVerified);

  // Prefer dated + classified records; they carry the most decision value.
  const ranked = verified
    .slice()
    .sort((a, b) => {
      const ad = a.published_at || "0000";
      const bd = b.published_at || "0000";
      if (ad !== bd) return bd.localeCompare(ad);
      return (b.evidence || "").length - (a.evidence || "").length;
    })
    .slice(0, maxSignals);

  const signals = ranked.map(r => ({
    id: recordId(r),
    brand: brand(r.brand_id).name,
    is_us: r.brand_id === "document360",
    channel: r.channel,
    date: r.published_at || "unknown",
    sentiment: r.sentiment || "unclassified",
    evidence: r.evidence,
  }));

  const ai = readJson(path.join(STORE_DIR, "ai-visibility.json"), null);
  const aiSummary = ai && ai.claude && ai.claude.summary
    ? Object.fromEntries(
        brandOrder().map(id => [
          brand(id).name,
          {
            share_of_claude_answers_pct: ai.claude.summary[id]?.share_pct ?? null,
            median_position: ai.claude.summary[id]?.median_position ?? null,
          },
        ])
      )
    : null;

  writeJson(QUEUE, {
    built_at: new Date().toISOString(),
    our_brand: "Document360",
    tracked_competitors: brandOrder().filter(i => i !== "document360").map(i => brand(i).name),
    ai_visibility_summary: aiSummary,
    ai_visibility_note: aiSummary
      ? "Measured from Claude's native answers this run."
      : "AI visibility has not been measured yet — do not reference AI-answer share in any recommendation.",
    signal_count: signals.length,
    signals,
    instructions: {
      task:
        "You are Document360's competitive-intelligence lead. Produce 10-16 specific, start-this-week " +
        "recommendations grounded ONLY in the signals supplied above.",
      output_shape:
        '{"recommendations":[{"title":"<imperative, names the artifact, <=90 chars>",' +
        '"detail":"<2-3 sentences, concrete and actionable>","type":"capitalize_competitor|accelerate_llm|defend_position",' +
        '"owner":"<one function>","priority":"high|medium|low","competitor":"<name or null>",' +
        '"evidence_ids":["<id copied verbatim from signals>"],"reasoning":"<why these signals imply this action>"}]}',
      hard_rules: [
        "evidence_ids is MANDATORY and must contain at least one id copied verbatim from the signals list. Every id is resolved against the evidence store; a recommendation citing an unknown id is discarded entirely.",
        "Never assert a fact that is not visible in the cited evidence excerpts. No funding amounts, pricing, customer counts, or product claims unless they appear in a cited excerpt.",
        "title must be an imperative instruction that is NOT a prefix of detail. Do not restate the detail as the title.",
        "owner must be exactly one of: " + CHANNELS_OWNERS.join(", ") + ".",
        "Where a competitor is genuinely stronger, say where to compete instead rather than recommending an attack. Never recommend publicly attacking a named competitor.",
        "If the signals do not support 10 recommendations, return fewer. Do not pad.",
        "Only reference AI-answer visibility if ai_visibility_summary is present above.",
      ],
    },
  });
  return { signals: signals.length, queue: QUEUE, ai_measured: !!aiSummary };
}

function apply() {
  const file = readJson(ANSWERS, null);
  if (!file) return { ok: false, error: `no answers at ${ANSWERS}` };
  const recs = Array.isArray(file) ? file : file.recommendations || [];

  const store = loadMentions();
  const byId = new Map(store.records.filter(isVerified).map(r => [recordId(r), r]));

  const audit = { submitted: recs.length, accepted: 0, rejected: 0, rejections: [] };
  const accepted = [];

  for (const r of recs) {
    const reject = reason => {
      audit.rejected++;
      audit.rejections.push({ title: String(r && r.title || "").slice(0, 90), reason });
    };
    if (!r || !r.title || !r.detail) { reject("missing title or detail"); continue; }
    if (!TYPES.includes(r.type)) { reject(`invalid type "${r.type}"`); continue; }
    if (!PRIORITIES.includes(r.priority)) { reject(`invalid priority "${r.priority}"`); continue; }
    if (!CHANNELS_OWNERS.includes(r.owner)) { reject(`invalid owner "${r.owner}"`); continue; }

    // THE GROUNDING CHECK: every cited id must be a real verified record.
    const ids = Array.isArray(r.evidence_ids) ? r.evidence_ids : [];
    if (!ids.length) { reject("cites no evidence_ids"); continue; }
    const resolved = ids.map(id => byId.get(id)).filter(Boolean);
    if (!resolved.length) {
      reject(`none of its ${ids.length} evidence_ids exist in the evidence store`);
      continue;
    }
    const unknown = ids.length - resolved.length;

    // Guard the old bug: a title that merely restates the body.
    const t = String(r.title).trim();
    const d = String(r.detail).trim();
    if (d.toLowerCase().startsWith(t.toLowerCase().slice(0, Math.min(40, t.length)))) {
      reject("title is a prefix of detail (auto-sliced title, not a real instruction)");
      continue;
    }

    accepted.push({
      title: t.slice(0, 120),
      detail: d,
      type: r.type,
      owner: r.owner,
      priority: r.priority,
      competitor: r.competitor || null,
      reasoning: String(r.reasoning || "").slice(0, 400) || null,
      // Each becomes a clickable, verified citation in the UI.
      evidence: resolved.map(rec => ({
        id: recordId(rec),
        brand: brand(rec.brand_id).name,
        channel: rec.channel,
        date: rec.published_at || null,
        url: rec.url,
        domain: rec.domain,
        title: rec.title,
        excerpt: rec.evidence,
        sentiment: rec.sentiment || null,
        link_verified: !!rec.url_verified,
      })),
      unknown_evidence_ids_dropped: unknown || 0,
      generated_by: "claude-code (grounded in verified evidence store)",
    });
    audit.accepted++;
  }

  saveRecs({
    generated_at: new Date().toISOString(),
    method:
      "Claude Code, constrained to the verified evidence store. Every recommendation cites record ids " +
      "that were resolved against the store; uncited or unresolvable ones were rejected.",
    audit,
    recommendations: accepted,
  });
  return { ok: true, ...audit };
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === "build") {
    const r = build();
    console.log(`\nQueued ${r.signals} verified signals for recommendation generation`);
    console.log(`  → ${r.queue}`);
    if (!r.ai_measured)
      console.log(`  note: AI visibility not measured yet — recommendations must not cite AI-answer share`);
    console.log(`\nClaude Code writes {"recommendations":[…]} to`);
    console.log(`  collectors/store/claude-rec-answers.json, then:`);
    console.log(`  node collectors/claude/recommend.js apply\n`);
  } else if (cmd === "apply") {
    const r = apply();
    if (!r.ok) { console.error("  ! " + r.error); process.exit(1); }
    console.log(`\nRecommendations: ${r.accepted} accepted, ${r.rejected} rejected of ${r.submitted}`);
    for (const rej of r.rejections.slice(0, 10)) console.log(`  ✗ ${rej.reason}: "${rej.title}"`);
    console.log("");
  } else {
    console.log("usage: node collectors/claude/recommend.js build | apply");
  }
}

module.exports = { build, apply, QUEUE, ANSWERS };
