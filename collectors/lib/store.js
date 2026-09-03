/**
 * The evidence store: collectors/store/mentions.json
 *
 * Append-and-merge, keyed by (brand, channel, canonical_url). Re-running a
 * collector never duplicates a mention and never silently discards a prior
 * Claude classification (see mergeRecord).
 *
 * Also records a run log so every number in the dashboard can be traced back to
 * the collector run that produced it.
 */
const fs = require("fs");
const path = require("path");
const { recordKey, mergeRecord, isVerified } = require("./record");

const STORE_DIR = path.join(__dirname, "..", "store");
const MENTIONS = path.join(STORE_DIR, "mentions.json");
const RUNS = path.join(STORE_DIR, "runs.json");
const AI = path.join(STORE_DIR, "ai-visibility.json");
const RECS = path.join(STORE_DIR, "recommendations.json");

function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error("  ! could not read " + path.basename(file) + ": " + e.message);
    return fallback;
  }
}

function writeJson(file, obj) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function loadMentions() {
  return readJson(MENTIONS, { updated_at: null, records: [] });
}

/**
 * Merge fresh records into the store.
 * Returns { added, updated, total, verified } so the caller can report honestly.
 */
function upsertMentions(fresh) {
  const store = loadMentions();
  const byKey = new Map(store.records.map(r => [recordKey(r), r]));
  let added = 0;
  let updated = 0;

  for (const f of fresh) {
    if (!f) continue;
    const k = recordKey(f);
    const prior = byKey.get(k);
    if (prior) {
      byKey.set(k, mergeRecord(prior, f));
      updated++;
    } else {
      byKey.set(k, { ...f, first_seen: f.fetched_at || new Date().toISOString() });
      added++;
    }
  }

  const records = [...byKey.values()];
  writeJson(MENTIONS, { updated_at: new Date().toISOString(), records });
  return {
    added,
    updated,
    total: records.length,
    verified: records.filter(isVerified).length,
  };
}

/** Replace the full record set (used by the re-verification pass). */
function replaceMentions(records) {
  writeJson(MENTIONS, { updated_at: new Date().toISOString(), records });
  return { total: records.length, verified: records.filter(isVerified).length };
}

/** Append a run-log entry: which adapter ran, what it found, what failed. */
function logRun(entry) {
  const runs = readJson(RUNS, { runs: [] });
  runs.runs.push({ at: new Date().toISOString(), ...entry });
  // Keep the log bounded but long enough to audit a quarter of daily runs.
  if (runs.runs.length > 500) runs.runs = runs.runs.slice(-500);
  writeJson(RUNS, runs);
}

function loadRuns() {
  return readJson(RUNS, { runs: [] });
}

function loadAI() {
  return readJson(AI, null);
}
function saveAI(obj) {
  writeJson(AI, obj);
}
function loadRecs() {
  return readJson(RECS, null);
}
function saveRecs(obj) {
  writeJson(RECS, obj);
}

module.exports = {
  STORE_DIR,
  MENTIONS,
  loadMentions,
  upsertMentions,
  replaceMentions,
  logRun,
  loadRuns,
  loadAI,
  saveAI,
  loadRecs,
  saveRecs,
  readJson,
  writeJson,
};
