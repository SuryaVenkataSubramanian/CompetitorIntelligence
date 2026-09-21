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
const os = require("os");
const path = require("path");
const { recordKey, mergeRecord, isVerified } = require("./record");
const { channelFromUrl } = require("./classify");

const STORE_DIR = path.join(__dirname, "..", "store");
const ROOT = path.join(__dirname, "..", "..");

/* ===========================================================================
 * READ-ONLY FILESYSTEMS
 *
 * On Vercel the deployment bundle is mounted at /var/task and is STRICTLY
 * read-only. Only os.tmpdir() is writable. The reported failure was:
 *
 *   EROFS: read-only file system,
 *   open '/var/task/collectors/store/freshsources-state.json'
 *
 * WHAT THAT ACTUALLY COST, which is worse than it looks: the sweep had already
 * finished. Every source had been queried, YouTube had 2 videos, GitHub 2
 * issues, Reddit 7 posts — and then saveState() threw on the last line, the
 * exception escaped sweep(), and the whole request 500'd. All the collected
 * work was discarded because a cache file could not be written.
 *
 * So there are two separate fixes here and both matter:
 *
 *   1. WRITE SOMEWHERE WRITABLE. Every path under the project root is mirrored
 *      into os.tmpdir() when the filesystem is read-only.
 *   2. NEVER THROW. A state file is an optimisation. Losing it must cost the
 *      optimisation, never the data.
 *
 * READS ARE MIRROR-FIRST, BUNDLE-SECOND. This is the part that is easy to get
 * wrong: a warm Lambda that wrote state to /tmp must read /tmp back, or it
 * reads the stale copy baked into the bundle and the write may as well not have
 * happened. But a COLD Lambda has no /tmp copy and must fall through to the
 * bundled file, which is the committed data the dashboard serves.
 *
 * WHAT DOES NOT SURVIVE: /tmp is per-instance and is discarded on a cold start.
 * Anything that must outlive that needs a database, and this project has none —
 * it is a zero-dependency Node app with no Prisma and no Postgres. The two
 * pieces of state affected are named in lib/freshsources.js, with what their
 * loss actually costs.
 * ======================================================================== */

let readOnlyRoot = null;

/** Is the deployment bundle writable? Probed once, then cached. */
function rootIsReadOnly() {
  if (readOnlyRoot !== null) return readOnlyRoot;
  // Vercel / Lambda are known read-only; trust the env rather than probing.
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY) {
    readOnlyRoot = true;
    return readOnlyRoot;
  }
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const probe = path.join(STORE_DIR, ".write-probe");
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    readOnlyRoot = false;
  } catch (e) {
    readOnlyRoot = true;
  }
  return readOnlyRoot;
}

/** Where a project-relative file lives when the bundle cannot be written. */
function mirrorPath(file) {
  const rel = path.relative(ROOT, file);
  // A path outside the project root is not ours to mirror.
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return file;
  return path.join(os.tmpdir(), "d360ci", rel);
}

/** The path to WRITE for a given logical file. */
function writePathFor(file) {
  return rootIsReadOnly() ? mirrorPath(file) : file;
}

/** The path to READ: the mirror if it has content, else the bundled original. */
function readPathFor(file) {
  if (!rootIsReadOnly()) return file;
  const mirror = mirrorPath(file);
  try {
    if (fs.existsSync(mirror)) return mirror;
  } catch (e) { /* fall through to the bundle */ }
  return file;
}
const MENTIONS = path.join(STORE_DIR, "mentions.json");
const RUNS = path.join(STORE_DIR, "runs.json");
const AI = path.join(STORE_DIR, "ai-visibility.json");
const RECS = path.join(STORE_DIR, "recommendations.json");

function ensureDir() {
  const dir = writePathFor(STORE_DIR);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) { /* writeJson reports it */ }
}

function readJson(file, fallback) {
  const target = readPathFor(file);
  try {
    if (!fs.existsSync(target)) return fallback;
    const raw = fs.readFileSync(target, "utf8").trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error("  ! could not read " + path.basename(file) + ": " + e.message);
    return fallback;
  }
}

/**
 * Write JSON, and NEVER THROW.
 *
 * Returns a receipt instead: { ok, persisted, path, error }. `persisted` is the
 * one callers should care about — it is false when the write landed in /tmp,
 * which survives warm invocations of the same instance and nothing else.
 *
 * Written atomically via a temp file and a rename, so a crash mid-write cannot
 * leave a half-written JSON file that every subsequent read fails to parse.
 */
function writeJson(file, obj) {
  const target = writePathFor(file);
  const body = JSON.stringify(obj, null, 2);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, target);
    return { ok: true, persisted: !rootIsReadOnly(), path: target, error: null };
  } catch (e) {
    // Last resort: a non-atomic write. Some filesystems refuse rename across
    // devices even when a plain write succeeds.
    try {
      fs.writeFileSync(target, body);
      return { ok: true, persisted: !rootIsReadOnly(), path: target, error: null };
    } catch (e2) {
      return {
        ok: false,
        persisted: false,
        path: target,
        error: String(e2.message || e2),
      };
    }
  }
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

  /* FOLD, DO NOT OVERWRITE.
   *
   * `new Map(records.map(r => [key, r]))` silently keeps the LAST record for a
   * repeated key. That was harmless while the key contained the channel and
   * collisions were impossible; now that identity is channel-free (see
   * record.recordKey), records already in the store CAN collide — and dropping
   * one of them would discard a real mention and its provenance without a word.
   *
   * Merging instead means the migration to the new key is lossless: the older
   * first_seen survives, and the richer record's fields win. */
  const byKey = new Map();
  let collapsed = 0;
  for (const r of store.records) {
    const k = recordKey(r);
    const prior = byKey.get(k);
    if (!prior) { byKey.set(k, r); continue; }
    collapsed++;
    // Order by first_seen so mergeRecord's "keep the earliest sighting" holds.
    const [older, newer] = String(prior.first_seen || "") <= String(r.first_seen || "")
      ? [prior, r] : [r, prior];
    const merged = mergeRecord(older, newer);
    /* The channel a URL implies beats the channel a collector guessed. A
     * linkedin.com/posts URL is a LinkedIn post whichever adapter found it. */
    const fromUrl = channelFromUrl(merged.url);
    if (fromUrl) merged.channel = fromUrl;
    byKey.set(k, merged);
  }
  if (collapsed) {
    console.log(`    collapsed ${collapsed} record(s) that shared a brand and URL under different channels`);
  }
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
  rootIsReadOnly,
  writePathFor,
  readPathFor,
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
