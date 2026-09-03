/**
 * Builds the work queue Claude Code consumes, and applies its answers back.
 *
 *   node collectors/claude/queue.js build   → store/pending-classification.json
 *   node collectors/claude/queue.js apply   → validates + writes into the store
 *
 * This is how "Claude as the default logic" is baked in without an API key: the
 * Claude Code session the user is already running IS the model runtime. Node does
 * all fetching and all validation; Claude only ever performs judgement tasks on
 * text Node already proved was fetched.
 *
 * THE CONTRACT THAT PREVENTS HALLUCINATION
 * ----------------------------------------
 * Claude is shown, per item: the brand name and the verbatim evidence excerpt.
 * It is NOT shown the URL, title or domain — so it cannot pattern-match on a
 * reputable-looking source instead of reading the text.
 *
 * Claude must return, per item: sentiment + a `quote` that is a CONTIGUOUS
 * SUBSTRING of the excerpt it was given. `apply` re-checks that substring
 * mechanically. If the quote is not literally present, the classification is
 * REJECTED and the record stays unclassified. A fabricated justification cannot
 * survive this check, which is what makes the sentiment column auditable rather
 * than merely plausible.
 *
 * There is no heuristic fallback. An unclassified record renders as
 * "unclassified" in the UI and is excluded from sentiment metrics — never
 * silently counted as neutral, because "we don't know" and "it's neutral" are
 * different business facts.
 */
const path = require("path");
const { loadMentions, replaceMentions, readJson, writeJson, STORE_DIR } = require("../lib/store");
const { isVerified } = require("../lib/record");
const { brand } = require("../lib/brands");

const QUEUE = path.join(STORE_DIR, "pending-classification.json");
const ANSWERS = path.join(STORE_DIR, "claude-answers.json");

const VALID_SENTIMENT = ["positive", "negative", "neutral"];

/** Normalise whitespace/quotes so a quote check isn't defeated by formatting. */
function loose(s) {
  return String(s || "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function build({ limit = 0, rebuildAll = false } = {}) {
  const store = loadMentions();
  const pending = store.records.filter(
    r => isVerified(r) && (rebuildAll || !r.sentiment)
  );
  const items = (limit > 0 ? pending.slice(0, limit) : pending).map(r => ({
    id: `${r.brand_id}::${r.channel}::${r.canonical_url}`,
    brand: brand(r.brand_id).name,
    channel: r.channel,
    // Deliberately no url / domain / title: judge the text, not the source.
    evidence: r.evidence,
  }));

  writeJson(QUEUE, {
    built_at: new Date().toISOString(),
    count: items.length,
    instructions: {
      task:
        "For each item, classify the sentiment the EVIDENCE TEXT expresses toward the named BRAND.",
      output_shape:
        '{"answers":[{"id":"<copied verbatim>","sentiment":"positive|negative|neutral","quote":"<contiguous substring of that item\'s evidence>","rationale":"<one short clause>"}]}',
      hard_rules: [
        "Judge ONLY the supplied evidence text. You have no other information about the item, and must not infer any.",
        "`quote` MUST be copied character-for-character from that item's evidence. It is checked mechanically; a non-matching quote causes the whole answer to be discarded.",
        "positive = the text expresses approval/advantage FOR the brand. negative = criticism, a limitation, or a competitor being preferred over it. neutral = the brand is named without evaluation (listings, factual mentions, feature descriptions).",
        "If the evidence is too thin to judge, return sentiment \"neutral\" with a quote showing the bare mention. Do NOT guess a direction to seem decisive.",
        "Return every id you were given, exactly once.",
      ],
    },
    items,
  });
  return { count: items.length, queue: QUEUE };
}

function apply() {
  const answersFile = readJson(ANSWERS, null);
  if (!answersFile) {
    return { ok: false, error: `no answers found at ${ANSWERS}` };
  }
  const answers = Array.isArray(answersFile) ? answersFile : answersFile.answers || [];
  const queue = readJson(QUEUE, { items: [] });
  const byId = new Map(queue.items.map(i => [i.id, i]));

  const store = loadMentions();
  const recById = new Map(
    store.records.map(r => [`${r.brand_id}::${r.channel}::${r.canonical_url}`, r])
  );

  const result = {
    applied: 0,
    rejected_unknown_id: 0,
    rejected_bad_sentiment: 0,
    rejected_quote_not_found: 0,
    rejections: [],
  };

  for (const a of answers) {
    const item = byId.get(a && a.id);
    const rec = recById.get(a && a.id);
    if (!item || !rec) {
      result.rejected_unknown_id++;
      result.rejections.push({ id: a && a.id, reason: "id not in queue/store" });
      continue;
    }
    if (!VALID_SENTIMENT.includes(a.sentiment)) {
      result.rejected_bad_sentiment++;
      result.rejections.push({ id: a.id, reason: `invalid sentiment "${a.sentiment}"` });
      continue;
    }
    // THE GROUNDING CHECK: the quote must literally occur in the evidence shown.
    const hay = loose(item.evidence);
    const needle = loose(a.quote);
    if (!needle || needle.length < 8 || !hay.includes(needle)) {
      result.rejected_quote_not_found++;
      result.rejections.push({
        id: a.id,
        reason: `quote is not a substring of the evidence shown to the model — classification discarded`,
        quote: String(a.quote || "").slice(0, 120),
      });
      continue;
    }

    rec.sentiment = a.sentiment;
    rec.sentiment_method = "claude-code (grounded quote verified)";
    rec.sentiment_rationale = String(a.rationale || "").slice(0, 300) || null;
    rec.sentiment_quote = String(a.quote).slice(0, 300);
    rec.sentiment_at = new Date().toISOString();
    result.applied++;
  }

  replaceMentions(store.records);
  writeJson(path.join(STORE_DIR, "classification-audit.json"), {
    applied_at: new Date().toISOString(),
    ...result,
  });
  return { ok: true, ...result };
}

if (require.main === module) {
  const cmd = process.argv[2];
  const limitArg = (process.argv.find(a => a.startsWith("--limit=")) || "").split("=")[1];
  const all = process.argv.includes("--all");

  if (cmd === "build") {
    const r = build({ limit: parseInt(limitArg, 10) || 0, rebuildAll: all });
    console.log(`\nQueued ${r.count} record(s) for Claude classification`);
    console.log(`  → ${r.queue}`);
    if (r.count === 0) console.log("  (nothing unclassified — use --all to reclassify everything)");
    console.log(`\nClaude Code should now read that file, classify each item, and write`);
    console.log(`{"answers":[…]} to collectors/store/claude-answers.json, then:`);
    console.log(`  node collectors/claude/queue.js apply\n`);
  } else if (cmd === "apply") {
    const r = apply();
    if (!r.ok) {
      console.error("  ! " + r.error);
      process.exit(1);
    }
    console.log(`\nApplied ${r.applied} classification(s)`);
    const rej =
      r.rejected_quote_not_found + r.rejected_bad_sentiment + r.rejected_unknown_id;
    if (rej) {
      console.log(`  rejected ${rej}:`);
      if (r.rejected_quote_not_found)
        console.log(`    ${r.rejected_quote_not_found} ungrounded quote (not found in the evidence shown)`);
      if (r.rejected_bad_sentiment) console.log(`    ${r.rejected_bad_sentiment} invalid sentiment value`);
      if (r.rejected_unknown_id) console.log(`    ${r.rejected_unknown_id} unknown id`);
      console.log(`  see store/classification-audit.json`);
    }
    console.log("");
  } else {
    console.log("usage: node collectors/claude/queue.js build [--limit=N] [--all] | apply");
  }
}

module.exports = { build, apply, QUEUE, ANSWERS };
