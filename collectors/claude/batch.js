/**
 * Compact batch dump for sentiment classification.
 *   node collectors/claude/batch.js <n> [brand]
 *
 * Prints one line per unclassified record: index, brand, channel, evidence.
 * Deliberately omits URL/domain/title — the classifier must judge the text, not
 * the reputation of the source.
 *
 * The id order is PINNED to store/batch-ids.json at dump time. Recomputing the
 * slice at apply time would be a race: collection runs concurrently and inserts
 * records, so index 7 could bind to a different record than the one that was
 * read. Pinning makes the mapping stable regardless of what the collectors do.
 */
const fs = require("fs");
const path = require("path");
const { loadMentions, STORE_DIR } = require("../lib/store");
const { isVerified } = require("../lib/record");
const { brand } = require("../lib/brands");

const n = parseInt(process.argv[2], 10) || 50;
const only = process.argv[3] || null;

const recs = loadMentions().records
  .filter(r => isVerified(r) && !r.sentiment)
  .filter(r => !only || r.brand_id === only)
  .slice(0, n);

fs.writeFileSync(
  path.join(STORE_DIR, "batch-ids.json"),
  JSON.stringify({
    pinned_at: new Date().toISOString(),
    brand_filter: only,
    ids: recs.map(r => `${r.brand_id}::${r.channel}::${r.canonical_url}`),
  }, null, 2)
);

console.log(JSON.stringify({ count: recs.length, brand_filter: only, pinned: true }));
recs.forEach((r, i) => {
  const ev = String(r.evidence).replace(/\s+/g, " ").trim();
  console.log(`${i}\t${brand(r.brand_id).name}\t${r.channel}\t${ev}`);
});
