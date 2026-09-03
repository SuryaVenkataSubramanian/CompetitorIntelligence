#!/usr/bin/env node
/**
 * Windsor.ai capability probe + YouTube engagement enrichment.
 *
 *   npm run windsor:probe    what this account has connected
 *   npm run windsor:enrich   attach real view/like counts to YouTube mentions
 *
 * WHY A PROBE RATHER THAN ASSUMPTIONS
 * -----------------------------------
 * Windsor is an aggregator: what it can return depends entirely on which
 * accounts the Windsor user has linked, and an unlinked connector returns
 * HTTP 400 "No <x> account for user …" — which is a different fact from "no
 * data in this period". Probing writes the answer to
 * collectors/store/windsor-capabilities.json so adapters and the health check
 * read a measured capability list instead of a hopeful one.
 */
const fs = require("fs");
const path = require("path");
const { load } = require("./lib/env");
const windsor = require("./lib/windsor");
const { readJson, writeJson, STORE_DIR } = require("./lib/store");

load();

const OUT = path.join(STORE_DIR, "windsor-capabilities.json");
const MENTIONS = path.join(STORE_DIR, "mentions.json");

async function probe() {
  const cred = windsor.credentialStatus();
  if (!cred.ok) {
    console.error("\n  " + cred.reason + "\n");
    process.exit(1);
  }

  console.log("\n  Windsor.ai capability probe\n");
  const conns = await windsor.connectors({ log: m => console.log(m) });

  const available = conns.filter(c => c.available);
  console.log(`\n  ${available.length} of ${conns.length} connector(s) have data`);
  for (const c of conns.filter(c => !c.available)) {
    console.log(`    ${c.connector.padEnd(20)} ${String(c.reason).slice(0, 70)}`);
  }

  // The AI-referral aggregate is the reason this integration exists, so prove it.
  let referrals = null;
  if (available.some(c => c.connector === "googleanalytics4")) {
    console.log("\n  Google Analytics 4 — AI assistant referrals (90 days):");
    const r = await windsor.aiReferrals({ log: () => {} });
    if (!r.ok) {
      console.log("    unavailable: " + r.error);
    } else {
      referrals = r;
      console.log(`    ${r.ai_sessions} of ${r.total_sessions} sessions (${r.ai_share_pct}%)`);
      for (const s of r.surfaces) {
        console.log(`      ${s.label.padEnd(12)} ${String(s.sessions).padStart(6)}  ${s.share_of_ai_pct}% of AI traffic`);
      }
      console.log("    top landing pages:");
      for (const p of r.top_landing_pages.slice(0, 6)) {
        console.log(`      ${String(p.sessions).padStart(5)}  ${p.page}`);
      }
    }
  }

  let videos = null;
  if (available.some(c => c.connector === "youtube")) {
    const y = await windsor.youtubeVideos({ log: () => {} });
    if (y.ok) {
      videos = y.videos;
      console.log(`\n  YouTube — ${y.videos.length} video row(s) on the connected channel`);
      for (const v of y.videos.slice(0, 5)) {
        console.log(`    ${String(v.views ?? "—").padStart(8)} views  ${String(v.title || v.video_id || "").slice(0, 58)}`);
      }
    }
  }

  writeJson(OUT, {
    probed_at: new Date().toISOString(),
    connectors: conns,
    available: available.map(c => c.connector),
    ai_referrals_summary: referrals ? {
      total_sessions: referrals.total_sessions,
      ai_sessions: referrals.ai_sessions,
      ai_share_pct: referrals.ai_share_pct,
      surfaces: referrals.surfaces.map(s => ({ id: s.id, label: s.label, sessions: s.sessions })),
    } : null,
    youtube_videos: videos ? videos.length : null,
    scope_limit:
      "Windsor exposes FIRST-PARTY data only — Document360's own analytics, channel and ad accounts. " +
      "It can enrich the Document360 view and says nothing about competitors, so competitor figures are " +
      "unavailable from this source rather than zero.",
  });
  console.log(`\n  written: collectors/store/windsor-capabilities.json\n`);
}

/**
 * Attach real YouTube engagement to stored mentions.
 *
 * Only matches on video id, so a record is enriched only when it is provably
 * the same video. Nothing is inferred from a title similarity.
 */
async function enrich() {
  const cred = windsor.credentialStatus();
  if (!cred.ok) { console.error("\n  " + cred.reason + "\n"); process.exit(1); }

  const y = await windsor.youtubeVideos({ log: m => console.log(m) });
  if (!y.ok) { console.error("\n  YouTube data unavailable: " + y.error + "\n"); process.exit(1); }

  const byId = new Map();
  for (const v of y.videos) if (v.video_id) byId.set(String(v.video_id), v);
  console.log(`\n  ${byId.size} video(s) with metrics from the connected channel`);

  const store = readJson(MENTIONS, null);
  if (!store || !Array.isArray(store.records)) { console.error("  ! no mention store"); process.exit(1); }

  const videoId = url => {
    const m = String(url).match(/[?&]v=([\w-]{6,})|youtu\.be\/([\w-]{6,})/);
    return m ? (m[1] || m[2]) : null;
  };

  let enriched = 0;
  for (const r of store.records) {
    const id = videoId(r.url);
    if (!id || !byId.has(id)) continue;
    const v = byId.get(id);
    r.engagement = {
      ...(r.engagement || {}),
      views: v.views,
      likes: v.likes,
      comments: v.comments,
      // Attributed, so a figure is never mistaken for something we computed.
      engagement_source: "Google/YouTube via Windsor.ai (first-party channel analytics)",
      engagement_fetched_at: y.fetched_at,
    };
    enriched++;
    console.log(`    ${String(v.views ?? "—").padStart(8)} views  ${String(v.title || id).slice(0, 56)}`);
  }

  if (!enriched) {
    console.log("\n  No stored mention matched a video on the connected channel by id.");
    console.log("  The channel Windsor exposes may differ from the one in config/brands.json,");
    console.log("  in which case there is genuinely nothing to join on — not an error.\n");
    return;
  }

  writeJson(MENTIONS, { ...store, updated_at: new Date().toISOString() });
  console.log(`\n  enriched ${enriched} mention record(s) with real engagement`);
  console.log(`  Next: node collectors/build.js\n`);
}

if (require.main === module) {
  const cmd = process.argv[2] || "probe";
  (cmd === "enrich" ? enrich() : probe()).catch(e => {
    console.error("  ! " + e.message);
    process.exit(1);
  });
}

module.exports = { probe, enrich, OUT };
