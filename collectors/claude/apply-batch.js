/**
 * Applies a batch keyed by the ids PINNED by batch.js, so a concurrent collector
 * run cannot shift what an index refers to.
 * stdin TSV:  index <TAB> sentiment <TAB> quote
 * The quote is still verified as a substring of that record's evidence by
 * queue.js's grounding check; this only removes index/id drift.
 */
const fs = require("fs");
const path = require("path");
const { readJson, STORE_DIR } = require("../lib/store");

// queue.js apply validates ids against pending-classification.json, so that queue
// must exist and contain these records. Building it here removes a step that is
// easy to forget and produces a confusing "unknown id" rejection for everything.
require("./queue").build();

const pinned = readJson(path.join(STORE_DIR, "batch-ids.json"), null);
if (!pinned) {
  console.error("no store/batch-ids.json — run batch.js first");
  process.exit(1);
}

const lines = fs.readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
const answers = [];
const bad = [];
for (const line of lines) {
  const [idx, sentiment, ...rest] = line.split("\t");
  const id = pinned.ids[parseInt(idx, 10)];
  if (!id) { bad.push(`index ${idx} not in pinned set`); continue; }
  answers.push({ id, sentiment: (sentiment || "").trim(), quote: rest.join("\t").trim(), rationale: null });
}
fs.writeFileSync(path.join(STORE_DIR, "claude-answers.json"), JSON.stringify({ answers }, null, 2));
console.log(`wrote ${answers.length} answers from ${pinned.ids.length} pinned ids${bad.length ? ` (${bad.length} skipped)` : ""}`);
