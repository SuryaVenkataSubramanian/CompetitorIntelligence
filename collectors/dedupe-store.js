/**
 * One-off / periodic store-wide deduplication.  `npm run dedupe`
 *
 * The collector dedupes each adapter's NEW output against the store, but records
 * that entered before cross-API dedupe existed were never compared to each other.
 * A single run found 220 such duplicates: the same article stored under an http/
 * https variant, a ?utm_ variant, an AMP copy, or a syndicated repost on another
 * domain.
 *
 * Every collapse is written to store/dedupe-report.json with the reason and the
 * URLs removed, so the Data Quality panel can report it and a human can audit it.
 */
const path = require("path");
const { loadMentions, replaceMentions, writeJson, STORE_DIR } = require("./lib/store");
const { dedupe } = require("./lib/dedupe");

const before = loadMentions().records;
console.log(`\nDeduplicating ${before.length} stored records…`);

const r = dedupe(before);

const byReason = {};
for (const g of r.groups) {
  const k = g.reason.replace(/\d+%/, "N%");
  byReason[k] = (byReason[k] || 0) + g.removed.length;
}

replaceMentions(r.records);
writeJson(path.join(STORE_DIR, "dedupe-report.json"), {
  run_at: new Date().toISOString(),
  before: before.length,
  after: r.records.length,
  removed: r.removed,
  by_reason: byReason,
  groups: r.groups.slice(0, 500),
});

console.log(`  before: ${before.length}`);
console.log(`  after:  ${r.records.length}`);
console.log(`  removed: ${r.removed}`);
for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(v).padStart(4)}  ${k}`);
}
const corroborated = r.records.filter(x => (x.also_seen_in || []).length);
console.log(`\n  ${corroborated.length} record(s) now carry cross-source corroboration (also_seen_in)`);
console.log(`  report: store/dedupe-report.json\n`);
