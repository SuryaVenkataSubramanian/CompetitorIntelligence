#!/usr/bin/env node
/**
 * Re-apply TODAY'S accuracy gates to every record already in the store.
 *
 *   node collectors/revalidate-store.js --dry-run   report only
 *   node collectors/revalidate-store.js             repair, then purge failures
 *
 * WHY THIS IS NEEDED
 * ------------------
 * The gates have tightened over time. Records admitted under the older, looser
 * rules are still in the store, and they fail checks that no new record could:
 *
 *   · 29 records whose evidence excerpt does not contain the brand it is
 *     attributed to. The pipeline now refuses those outright, but these predate
 *     that guarantee. An excerpt that never names the brand cannot support the
 *     claim "this is a mention of X", and Claude is asked to judge sentiment
 *     from that excerpt alone — so it would be answering an unanswerable
 *     question.
 *   · 8 records filed under the wrong channel, because the finding adapter's
 *     name beat the URL's own domain. A youtube.com video under "Web" is
 *     missing from the YouTube filter.
 *
 * REPAIR BEFORE PURGE
 * -------------------
 * A failing record is not simply deleted. The page is re-fetched and evidence
 * re-extracted with the current extractor; many pass on the second attempt
 * because the brand genuinely is in the prose and the old extractor picked a
 * worse window. Only what still fails is removed, and every removal is recorded
 * with its reason in data/audit.json so the exclusion stays auditable.
 */
const fs = require("fs");
const path = require("path");
const { load } = require("./lib/env");
const { fetchUrl, pool } = require("./lib/fetch");
const { htmlToText, extractEvidence } = require("./lib/verify");
const { matchBrand, brand } = require("./lib/brands");
const { channelFromUrl } = require("./lib/classify");
const { readJson, writeJson, STORE_DIR } = require("./lib/store");

load();

const STORE = path.join(STORE_DIR, "mentions.json");
const DRY = process.argv.includes("--dry-run");
const MIN_EVIDENCE_CHARS = 60;

/** Does this record's own excerpt name the brand it is attributed to? */
function evidenceNamesBrand(rec) {
  const aliases = (brand(rec.brand_id) || {}).aliases || [];
  const ev = String(rec.evidence || "");
  return aliases.some(a => ev.toLowerCase().includes(String(a).toLowerCase()));
}

(async () => {
  const store = readJson(STORE, null);
  if (!store || !Array.isArray(store.records)) {
    console.error("  ! no store at " + STORE);
    process.exit(1);
  }
  const records = store.records;
  console.log(`\nRevalidating ${records.length} stored record(s) against the current gates`);
  console.log(`  mode: ${DRY ? "DRY RUN (no writes)" : "repair + purge"}\n`);

  /* ------------------------------------------------- 1. cheap, offline fixes */
  let channelFixed = 0;
  const channelChanges = [];
  for (const r of records) {
    const fromUrl = channelFromUrl(r.url);
    // `event` is a semantic classification, not a platform, so it is preserved.
    if (fromUrl && r.channel !== fromUrl && r.channel !== "event") {
      channelChanges.push({ url: r.url, brand: r.brand_id, from: r.channel, to: fromUrl });
      if (!DRY) r.channel = fromUrl;
      channelFixed++;
    }
  }
  console.log(`  channel corrections: ${channelFixed}`);
  for (const c of channelChanges.slice(0, 6)) {
    console.log(`      ${c.brand.padEnd(13)} ${c.from} → ${c.to}   ${String(c.url).slice(0, 58)}`);
  }

  /* ---------------------------------------- 2. evidence gate + live repair */
  const failing = records.filter(r => !evidenceNamesBrand(r));
  console.log(`\n  records whose excerpt does not name their brand: ${failing.length}`);

  const repaired = [];
  const unrepairable = [];

  if (failing.length) {
    console.log(`  re-fetching each to re-extract evidence with the current extractor…\n`);
    await pool(failing, 6, async r => {
      const aliases = (brand(r.brand_id) || {}).aliases || [];
      const got = await fetchUrl(r.url, { retries: 1, timeout: 25000 });

      if (!got.ok) {
        unrepairable.push({ ...r, why: `page unreachable on re-fetch (HTTP ${got.status || "no response"})` });
        return;
      }
      const text = htmlToText(got.body);

      // The brand must be genuinely present in the fetched prose. Nav chrome is
      // already stripped by htmlToText, so a footer link cannot qualify.
      if (!matchBrand(text, r.brand_id).present) {
        unrepairable.push({ ...r, why: "brand not present in the fetched page prose (nav/footer chrome excluded)" });
        return;
      }

      const ev = extractEvidence(text, aliases, 420);
      const excerpt = ev ? ev.excerpt.replace(/^…|…$/g, "").trim() : "";
      const names = ev && aliases.some(a => ev.excerpt.toLowerCase().includes(String(a).toLowerCase()));

      if (!ev || excerpt.length < MIN_EVIDENCE_CHARS || !names) {
        unrepairable.push({ ...r, why: "no excerpt containing the brand could be extracted from the live page" });
        return;
      }

      repaired.push({
        url: r.url, brand: r.brand_id,
        old: String(r.evidence || "").slice(0, 70),
        new: ev.excerpt.slice(0, 70),
      });
      if (!DRY) {
        r.evidence = ev.excerpt;
        r.evidence_source = "fetched page text (re-extracted on revalidation)";
        r.revalidated_at = new Date().toISOString();
        // Sentiment was judged from the OLD excerpt, which did not name the
        // brand. That judgement cannot be carried over to new evidence.
        if (r.sentiment && /claude/i.test(r.sentiment_method || "")) {
          r.sentiment = null;
          r.sentiment_method = null;
          r.sentiment_quote = null;
          r.sentiment_reset_reason = "evidence was re-extracted; the prior classification was made from an excerpt that did not name the brand";
        }
      }
    });
  }

  console.log(`  repaired from the live page: ${repaired.length}`);
  for (const r of repaired.slice(0, 5)) {
    console.log(`      ${r.brand.padEnd(13)} ${String(r.url).slice(0, 56)}`);
    console.log(`        was: "${r.old}…"`);
    console.log(`        now: "${r.new}…"`);
  }

  console.log(`\n  unrepairable, to be removed: ${unrepairable.length}`);
  const byWhy = {};
  for (const u of unrepairable) byWhy[u.why] = (byWhy[u.why] || 0) + 1;
  for (const [why, n] of Object.entries(byWhy)) console.log(`      ${String(n).padStart(3)}  ${why}`);
  for (const u of unrepairable.slice(0, 6)) {
    console.log(`      - ${String(u.brand_id).padEnd(13)} ${String(u.url).slice(0, 62)}`);
  }

  if (DRY) {
    console.log(`\n  DRY RUN — nothing written. Re-run without --dry-run to apply.\n`);
    process.exit(0);
  }

  /* --------------------------------------------------------------- 3. write */
  const removeSet = new Set(unrepairable.map(u => u.url + "|" + u.brand_id));
  const kept = records.filter(r => !removeSet.has(r.url + "|" + r.brand_id));

  writeJson(STORE, { ...store, records: kept, revalidated_at: new Date().toISOString() });

  // Removals go into the audit file so the Data Quality tab can show them.
  const auditPath = path.join(STORE_DIR, "revalidation-audit.json");
  writeJson(auditPath, {
    revalidated_at: new Date().toISOString(),
    before: records.length,
    after: kept.length,
    channel_corrections: channelChanges,
    evidence_repaired: repaired,
    removed: unrepairable.map(u => ({
      url: u.url, brand_id: u.brand_id, channel: u.channel,
      source: u.source_adapter || u.source, reason: u.why,
    })),
    method:
      "Every stored record was re-checked against the current gates. Records whose excerpt did not name " +
      "their attributed brand were re-fetched and re-extracted; those that still could not produce an " +
      "excerpt naming the brand were removed, because such a record cannot support the claim that it is " +
      "a mention of that product.",
  });

  console.log(`\n  store: ${records.length} → ${kept.length} records (-${records.length - kept.length})`);
  console.log(`  audit written to store/revalidation-audit.json`);
  console.log(`\n  Next: node collectors/build.js\n`);
})();
