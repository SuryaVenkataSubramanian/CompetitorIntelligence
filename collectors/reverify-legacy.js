/**
 * Re-verification of the legacy snapshot (collectors/raw/owned-mentions.json).
 *
 *   node collectors/reverify-legacy.js
 *
 * The old data had 66 mentions of which 46 carried no verifiable date and every
 * sentiment was unreviewed single-pass LLM output. Rather than trust or discard
 * it wholesale, each URL is re-fetched and put through exactly the same gate as
 * newly collected data:
 *
 *   HTTP 2xx  +  brand alias confirmed in the fetched text  +  auditable excerpt
 *
 * Records that pass are promoted into the evidence store with a real date parsed
 * from the page where one exists. Records that fail are written to
 * store/legacy-rejected.json with the reason, so the loss is inspectable instead
 * of invisible. Legacy sentiment is DELIBERATELY DROPPED — it was produced by the
 * same pass that found the mention, with no evidence excerpt attached, so it
 * cannot be audited. Claude re-classifies from the new excerpt instead.
 */
const fs = require("fs");
const path = require("path");
const { verifyCandidates } = require("./lib/pipeline");
const { upsertMentions, writeJson, STORE_DIR } = require("./lib/store");
const { brandOrder } = require("./lib/brands");

const LEGACY = path.join(__dirname, "raw", "owned-mentions.json");

// The legacy file used 4 brand ids; all 4 are still tracked. Its category strings
// map onto the new six-channel model.
const CATEGORY_TO_CHANNEL = {
  News: "web",
  Blog: "blog",
  Web: "web",
  Video: "video",
  Podcast: "web",
  Forum: "web",
  Reddit: "web",
  LinkedIn: "linkedin",
  X: "x",
  Facebook: "web",
  Instagram: "web",
  TikTok: "video",
};

(async () => {
  if (!fs.existsSync(LEGACY)) {
    console.log("No legacy snapshot at " + LEGACY + " — nothing to re-verify.");
    return;
  }
  const legacy = JSON.parse(fs.readFileSync(LEGACY, "utf8")).result;
  const known = new Set(brandOrder());

  const candidates = [];
  let skipped = 0;
  for (const [brandId, mentions] of Object.entries(legacy.brands || {})) {
    if (!known.has(brandId)) { skipped += (mentions || []).length; continue; }
    for (const m of mentions || []) {
      if (!m.url) { skipped++; continue; }
      candidates.push({
        brand_id: brandId,
        channel: CATEGORY_TO_CHANNEL[m.category] || "web",
        url: m.url,
        title: m.title || null,
        // The legacy date is only trusted when it was marked "exact"; the 47
        // "inferred" ones are treated as no date at all.
        published_at: m.date_confidence === "exact" && m.date ? m.date : null,
        date_method: m.date_confidence === "exact" && m.date ? "legacy:exact" : null,
        source_text: m.snippet || null,
        // The legacy snippet was written by the earlier LLM collection pass, not
        // copied from a fetched page. It must never become evidence, so a legacy
        // record can only survive on text fetched live right now.
        trust_source_text: false,
        source_verified: false, // must re-prove itself by fetch
        source_adapter: "legacy-reverified",
        discovered_via: "collectors/raw/owned-mentions.json (2026-08-09 snapshot)",
        author: m.author || null,
        extra: {
          legacy_sentiment_discarded: m.sentiment || null,
          legacy_influence: m.influence ?? null,
          legacy_category: m.category || null,
        },
      });
    }
  }

  console.log(`\nRe-verifying ${candidates.length} legacy mentions (${skipped} skipped: no URL or untracked brand)`);
  console.log("Gate: HTTP 2xx + brand confirmed in fetched text + auditable excerpt\n");

  const { records, stats, rejections } = await verifyCandidates(candidates, {
    concurrency: 4,
    log: m => console.log(m),
  });

  const merged = upsertMentions(records);
  writeJson(path.join(STORE_DIR, "legacy-rejected.json"), {
    reverified_at: new Date().toISOString(),
    submitted: candidates.length,
    passed: records.length,
    rejected: rejections.length,
    note:
      "These legacy mentions failed re-verification and are excluded from every dashboard metric. " +
      "Kept here so the exclusion is auditable.",
    rejections,
  });

  const byBrand = {};
  for (const r of records) byBrand[r.brand_id] = (byBrand[r.brand_id] || 0) + 1;

  console.log(`\n── Legacy re-verification result ──`);
  console.log(`  submitted:        ${candidates.length}`);
  console.log(`  passed the gate:  ${records.length}`);
  console.log(`  rejected:         ${rejections.length}  (see store/legacy-rejected.json)`);
  console.log(`  gained a real date: ${stats.dated} of ${records.length}`);
  console.log(`\n  per brand: ${Object.entries(byBrand).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  console.log(`\n  store: +${merged.added} new, ${merged.updated} updated → ${merged.total} total, ${merged.verified} verified`);
  console.log(`\n  Legacy sentiment was discarded for all ${records.length} survivors — it had no evidence`);
  console.log(`  excerpt and could not be audited. Run /refresh-intel so Claude re-classifies them.\n`);
})();
