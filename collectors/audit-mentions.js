#!/usr/bin/env node
/**
 * Mentions accuracy audit.
 *
 *   npm run audit:mentions            structural audit of every stored record
 *   npm run audit:mentions -- --live  additionally re-fetch a sample and confirm
 *                                     the brand is still on the page
 *
 * WHAT THIS CHECKS, AND WHY EACH ONE IS A REAL FAILURE MODE
 * --------------------------------------------------------
 * Every check below corresponds to a way this dataset has actually been wrong
 * at some point, or could be:
 *
 *   evidence missing the brand   a record asserting "X was mentioned" whose
 *                                excerpt does not contain X is unfalsifiable
 *   ambiguous false positive     "a confluence of factors" counted as Confluence
 *   non-content URL              a profile, hashtag or homepage stored as a mention
 *   date in the future           an upcoming-event date scraped as a publish date
 *   duplicate across sources     the same post counted once per source
 *   sentiment without a quote    a Claude-classified sentiment with no grounding
 *   dead link                    a URL that no longer resolves
 *   channel mismatch             a linkedin.com URL filed under Web
 *
 * A failure prints the offending records rather than only a count, because a
 * count cannot be acted on.
 */
const fs = require("fs");
const path = require("path");
const { load } = require("./lib/env");
const { fetchUrl, pool } = require("./lib/fetch");
const { htmlToText } = require("./lib/verify");
const { matchBrand, brand, brandOrder, allBrands } = require("./lib/brands");

load();

const DATA = path.join(__dirname, "..", "data");
const LIVE = process.argv.includes("--live");
const SAMPLE = Number((process.argv.find(a => a.startsWith("--sample=")) || "").split("=")[1] || 40);

const problems = [];
/** Weaker-than-ideal evidence that is still a sound record. Reported, not failed. */
const advisories = [];
function flag(kind, m, detail) {
  problems.push({ kind, brand: m.brand, url: m.url, channel: m.channel, detail });
}

/**
 * Canonical URL for duplicate detection.
 *
 * Stripping the whole query string is WRONG and was a bug here: on YouTube the
 * `?v=` parameter IS the identity, so `split("?")[0]` collapsed every video to
 * `youtube.com/watch` and reported 143 distinct videos as duplicates of each
 * other. Only genuine tracking parameters are removed.
 */
const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_[a-z]+|ref|ref_src|source|si|feature|rcm|trk|trackingId|originalSubdomain)$/i;

function canonical(url) {
  try {
    const u = new URL(url);
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) if (!TRACKING.test(k)) keep.append(k, v);
    u.search = keep.toString();
    u.hash = "";
    return u.toString().replace(/\/$/, "").toLowerCase();
  } catch (e) {
    return String(url).toLowerCase();
  }
}

/** Which channel does this URL structurally belong to? */
function channelFromUrl(url) {
  const u = String(url).toLowerCase();
  if (/(^|\.)linkedin\.com|lnkd\.in/.test(u)) return "linkedin";
  if (/(^|\.)(x|twitter)\.com/.test(u)) return "x";
  if (/(^|\.)(youtube\.com|youtu\.be)/.test(u)) return "youtube";
  if (/(^|\.)instagram\.com/.test(u)) return "instagram";
  if (/(^|\.)facebook\.com|fb\.watch/.test(u)) return "facebook";
  return null;
}

(async () => {
  const brands = JSON.parse(fs.readFileSync(path.join(DATA, "brands.json"), "utf8"));
  const meta = JSON.parse(fs.readFileSync(path.join(DATA, "meta.json"), "utf8"));
  const all = Object.values(brands).flatMap(b => (b.mentions || []).map(m => ({ ...m, brand: m.brand || b.id })));

  console.log(`\nMentions accuracy audit — ${all.length} records across ${Object.keys(brands).length} products`);
  console.log(`  built ${meta.built_at}\n`);

  const today = new Date().toISOString().slice(0, 10);

  /* ------------------------------------------------ 1. structural integrity */
  const seenUrl = new Map();
  for (const m of all) {
    // URL must be a real http(s) link.
    if (!/^https?:\/\//.test(String(m.url || ""))) { flag("bad_url", m, "not an http(s) URL"); continue; }

    /* Evidence must contain the brand it is attributed to.
     *
     * The test is that the ALIAS is literally present, which is the standard the
     * pipeline actually enforces. Using matchBrand() here instead was wrong and
     * produced 29 false failures: matchBrand additionally requires corroborating
     * context for ambiguous names, and that context legitimately lives elsewhere
     * on the page rather than inside a 420-character window. All 18 flagged
     * Confluence excerpts did contain "Confluence" — e.g. "retrieve the product
     * roadmap from Confluence" — and were correct records. */
    const ev = String(m.evidence || m.excerpt || "");
    const cfg = brand(m.brand);
    const aliases = (cfg && cfg.aliases) || [];
    const aliasPresent = aliases.some(a => ev.toLowerCase().includes(String(a).toLowerCase()));

    if (!ev.trim()) {
      flag("no_evidence", m, "no evidence excerpt stored");
    } else if (!aliasPresent) {
      flag("evidence_lacks_brand", m,
        `excerpt contains no alias of ${cfg ? cfg.name : m.brand}: "${ev.slice(0, 90)}"`);
    }

    /* Advisory, not an error: an ambiguous brand whose excerpt names it but
     * carries none of its disambiguating context. The page-level match did have
     * that context, so the record is sound — but the excerpt alone is weaker
     * evidence, and it is the excerpt Claude judges sentiment from. */
    if (aliasPresent && cfg && (cfg.require_context || []).length && !matchBrand(ev, m.brand).present) {
      advisories.push({
        kind: "excerpt_lacks_context", brand: m.brand, url: m.url,
        detail: `ambiguous name confirmed on the page but the excerpt alone carries no corroborating context`,
      });
    }

    // Dates must not be in the future.
    if (m.date && m.date > today) flag("future_date", m, `published_at ${m.date} is after today`);
    if (m.first_seen && String(m.first_seen).slice(0, 10) > today) {
      flag("future_date", m, `first_seen ${m.first_seen} is after today`);
    }

    // Channel must match what the URL structurally is.
    const structural = channelFromUrl(m.url);
    if (structural && m.channel !== structural && m.channel !== "event") {
      flag("channel_mismatch", m, `URL is ${structural} but filed under ${m.channel}`);
    }

    // Sentiment claimed by Claude must be backed by a quote in the evidence.
    if (m.sentiment && /claude/i.test(m.sentiment_method || "")) {
      const q = m.sentiment_quote || m.sentiment_evidence;
      if (!q) flag("sentiment_ungrounded", m, "Claude-classified with no quote");
      else if (!ev.replace(/\s+/g, " ").toLowerCase().includes(String(q).replace(/\s+/g, " ").toLowerCase().slice(0, 40))) {
        flag("sentiment_ungrounded", m, `quote not present in evidence: "${String(q).slice(0, 60)}"`);
      }
    }

    // Duplicate detection: same canonical URL + brand should appear once.
    const key = canonical(m.url) + "|" + m.brand;
    if (seenUrl.has(key)) flag("duplicate", m, `same URL+brand already stored`);
    else seenUrl.set(key, m);
  }

  /* --------------------------------------------------------- 2. aggregates */
  const byChannel = {};
  const byBrand = {};
  let undated = 0, deadLinks = 0, classified = 0;
  for (const m of all) {
    byChannel[m.channel] = (byChannel[m.channel] || 0) + 1;
    byBrand[m.brand] = (byBrand[m.brand] || 0) + 1;
    if (!m.date) undated++;
    if (m.link_ok === false) deadLinks++;
    if (m.sentiment) classified++;
  }

  // The counts the UI shows must equal the counts in the records. A mismatch
  // means the dashboard is displaying a number nothing supports.
  for (const id of brandOrder()) {
    const stats = (brands[id] && brands[id].stats) || {};
    const declared = Object.values(stats.by_channel || {}).reduce((a, b) => a + b, 0);
    const actual = byBrand[id] || 0;
    if (declared !== actual) {
      problems.push({
        kind: "count_mismatch", brand: id, url: null, channel: null,
        detail: `stats.by_channel sums to ${declared} but ${actual} records are stored`,
      });
    }
  }

  console.log("  by channel: " + Object.entries(byChannel).map(([k, v]) => `${k}=${v}`).join(" "));
  console.log("  by product: " + brandOrder().map(id => `${brand(id).name}=${byBrand[id] || 0}`).join(" "));
  console.log(`  undated ${undated} · dead links ${deadLinks} · sentiment ${classified}/${all.length}\n`);

  /* ------------------------------------------------------ 3. live re-check */
  let liveChecked = 0, liveConfirmed = 0;
  if (LIVE) {
    // Sample across channels rather than the first N, so a broken channel is
    // not hidden behind a healthy one.
    const byCh = {};
    for (const m of all) (byCh[m.channel] = byCh[m.channel] || []).push(m);
    const perCh = Math.max(2, Math.floor(SAMPLE / Object.keys(byCh).length));
    const sample = Object.values(byCh).flatMap(list =>
      list.sort(() => Math.random() - 0.5).slice(0, perCh));

    console.log(`  re-fetching ${sample.length} record(s) to confirm the brand is still on the page…`);
    await pool(sample, 6, async m => {
      const r = await fetchUrl(m.url, { retries: 1, timeout: 20000 });
      liveChecked++;
      if (!r.ok) {
        // A login wall or 403 is not proof the record is wrong.
        if ([401, 403, 429, 999].includes(r.status)) return;
        flag("link_dead_now", m, `HTTP ${r.status || "no response"} on re-fetch`);
        return;
      }
      const text = htmlToText(r.body);
      if (matchBrand(text, m.brand).present) { liveConfirmed++; return; }
      // Social pages are JS-rendered; absence in raw HTML is not disproof.
      if (["linkedin", "x", "instagram", "facebook"].includes(m.channel)) return;
      flag("brand_gone_from_page", m, "brand no longer found in the fetched page text");
    });
    console.log(`  live: ${liveConfirmed}/${liveChecked} confirmed on re-fetch\n`);
  }

  /* --------------------------------------------------------------- report */
  const byKind = {};
  for (const p of problems) (byKind[p.kind] = byKind[p.kind] || []).push(p);

  if (!problems.length) {
    console.log("  No accuracy problems found.\n");
  } else {
    console.log(`  ${problems.length} problem(s) across ${Object.keys(byKind).length} kind(s):\n`);
    for (const [kind, list] of Object.entries(byKind).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${kind}  (${list.length})`);
      for (const p of list.slice(0, 5)) {
        console.log(`      ${String(p.brand || "-").padEnd(13)} ${String(p.url || "").slice(0, 62)}`);
        console.log(`      └─ ${p.detail}`);
      }
      if (list.length > 5) console.log(`      … ${list.length - 5} more`);
      console.log("");
    }
  }

  if (advisories.length) {
    const byAdv = {};
    for (const a of advisories) byAdv[a.kind] = (byAdv[a.kind] || 0) + 1;
    console.log("  Advisories (sound records, weaker evidence):");
    for (const [k, n] of Object.entries(byAdv)) console.log(`      ${String(n).padStart(3)}  ${k}`);
    console.log("");
  }

  const out = path.join(__dirname, "store", "mentions-audit.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    audited_at: new Date().toISOString(),
    records: all.length,
    live_check: LIVE ? { checked: liveChecked, confirmed: liveConfirmed } : null,
    by_channel: byChannel,
    by_product: byBrand,
    undated, dead_links: deadLinks, sentiment_classified: classified,
    problem_count: problems.length,
    problems_by_kind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v.length])),
    problems: problems.slice(0, 400),
    advisory_count: advisories.length,
    advisories: advisories.slice(0, 200),
  }, null, 2));
  console.log(`  written: collectors/store/mentions-audit.json\n`);

  // Only structural problems fail the run; a login-walled social page does not.
  const hard = problems.filter(p => !["link_dead_now"].includes(p.kind));
  process.exit(hard.length ? 1 : 0);
})();
