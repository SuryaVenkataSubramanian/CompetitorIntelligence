#!/usr/bin/env node
/**
 * Backfill competitive classification and threat scoring for entrants that were
 * discovered before the threat engine existed.
 *
 *   node collectors/reassess-competitors.js            all unassessed
 *   node collectors/reassess-competitors.js --all      re-assess every entrant
 *
 * WHY A BACKFILL RATHER THAN A DEFAULT
 * ------------------------------------
 * An unassessed entrant renders as "not assessed", never as threat 0. That is
 * correct — a missing judgement is not a low threat — but it is also not
 * useful, and 26 unscored rows would leave the New Competitors tab mostly
 * empty of exactly the information it was asked to show.
 *
 * So each one is RE-FETCHED and assessed from its live homepage, on the same
 * evidence path a fresh discovery uses. Nothing is inferred from the stored
 * record: a page that no longer loads is marked unreachable rather than scored
 * from a stale excerpt.
 *
 * Entrants that the current, stricter host rules would now reject (a company's
 * own docs subdomain, for example) are marked so the dashboard can show why,
 * rather than being silently deleted — an exclusion the reader cannot see is
 * indistinguishable from a bug.
 */
const path = require("path");
const { fetchUrl, pool } = require("./lib/fetch");
const { htmlToText, extractTitle } = require("./lib/verify");
const { readJson, writeJson, STORE_DIR } = require("./lib/store");
const threat = require("./lib/threat");

const OUT = path.join(STORE_DIR, "competitors.json");
const DATA_OUT = path.join(__dirname, "..", "data", "competitors.json");

/** The page's own claim about what it is: title + meta description. */
function identityOf(html) {
  const desc = (String(html).match(
    /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i
  ) || [])[1] || "";
  return [extractTitle(html) || "", desc].filter(Boolean).join(". ");
}

(async () => {
  const all = process.argv.includes("--all");
  const store = readJson(OUT, null);
  if (!store || !Array.isArray(store.competitors)) {
    console.error("  ! no competitor store at " + OUT);
    process.exit(1);
  }

  const targets = store.competitors.filter(c => all || c.threat_score == null);
  if (!targets.length) {
    console.log("\n  Every entrant already carries an assessment. Nothing to do.\n");
    process.exit(0);
  }

  console.log(`\nRe-assessing ${targets.length} entrant(s) from their live homepages`);
  console.log(`  (${store.competitors.length} known in total)\n`);

  const byDomain = new Map();
  let ok = 0, unreachable = 0;

  await pool(targets, 6, async c => {
    const url = c.website || `https://${c.domain}/`;
    const r = await fetchUrl(url, { retries: 1, timeout: 20000 });
    if (!r.ok) {
      unreachable++;
      byDomain.set(c.domain, {
        ...c,
        assessment_status: "unreachable",
        // Explicitly NOT a score. The reader is told the page did not load.
        threat_score: null,
        threat_band: null,
        classification: null,
        classification_basis: `Homepage returned HTTP ${r.status || "no response"} on re-assessment, so no judgement could be made from its own words.`,
        reassessed_at: new Date().toISOString(),
      });
      console.log(`  ${"—".padStart(4)}  ${String(c.name).padEnd(24)} unreachable (HTTP ${r.status || "none"})`);
      return;
    }

    const text = htmlToText(r.body);
    const identity = identityOf(r.body);
    const a = threat.assess({ identity, body_text: text });
    const company = threat.extractCompany(r.body, c.name);
    const launch = threat.extractLaunchDate(r.body, text);

    // Refresh a stored name that was a page greeting rather than a product name
    // ("Welcome to Ensemble!"). The live title is the better source, and a site
    // that has since fixed its title should benefit from that.
    let name = c.name;
    let nameSource = c.name_source;
    if (/^(welcome to|home|homepage|untitled|index)\b/i.test(String(c.name || "").trim())) {
      const title = (extractTitle(r.body) || "").split(/\s*[|–—]\s*/).pop().trim();
      if (title && !/^(welcome|home)/i.test(title)) {
        name = title;
        nameSource = "current page title (stored name was a placeholder greeting)";
      }
    }

    byDomain.set(c.domain, {
      ...c,
      name,
      name_source: nameSource,
      company: c.company || company.company,
      company_source: c.company_source || company.method,
      company_same_as_product: company.same_as_product,
      launch_date: c.launch_date || (launch ? launch.date : null),
      launch_date_precision: c.launch_date_precision || (launch ? launch.precision : null),
      launch_date_basis: c.launch_date_basis || (launch ? `${launch.method}: "${launch.basis}"` : null),

      classification: a.classification,
      classification_basis: a.classification_basis,
      threat_score: a.threat_score,
      threat_band: a.threat_band,
      why_it_could_compete: a.why_it_could_compete,
      threat_signals: a.signals,
      assessment_confidence: a.assessment_confidence,
      assessment_method: a.method,
      assessment_status: "assessed",

      evidence_url: url,
      evidence_content_sha256: r.content_sha256,
      reassessed_at: new Date().toISOString(),
    });
    ok++;
    console.log(`  ${String(a.threat_score).padStart(4)}  ${String(c.name).padEnd(24)} ${a.classification}`);
  });

  /* ------------------------------------------------- retire stale admissions */
  // Entrants admitted under looser rules that the current gate would reject.
  // They are REMOVED from the entrant list but recorded in `retired` with the
  // reason, so the exclusion is auditable in the dashboard rather than silent.
  const DOCS_SUBDOMAIN = /^(docs?|help|support|developer|developers|dev|api|kb|knowledge|guide|guides|learn|manual|wiki|handbook|reference)\./i;
  const PLACEHOLDER_NAME = /^(welcome to|home|homepage|untitled|index)\b/i;

  const kept = [];
  const retired = [...(store.retired || [])];
  for (const c of store.competitors.map(x => byDomain.get(x.domain) || x)) {
    if (DOCS_SUBDOMAIN.test(c.domain || "")) {
      retired.push({
        domain: c.domain, name: c.name,
        reason: "a company's own documentation site, not a documentation product",
        retired_at: new Date().toISOString(),
      });
      continue;
    }
    if (PLACEHOLDER_NAME.test(String(c.name || "").trim())) {
      // "Welcome to Spice.ai" is a page title, not a product name. Rather than
      // guess the real name, take the domain's own label — which is what the
      // site is actually called — and record that the title was unusable.
      const label = String(c.domain || "").replace(/^www\./, "").split(".")[0];
      c.name = label.charAt(0).toUpperCase() + label.slice(1);
      c.name_source = "domain label (page title was a placeholder greeting)";
    }
    kept.push(c);
  }

  const merged = kept;
  merged.sort((a, b) =>
    ((b.threat_score || 0) - (a.threat_score || 0)) ||
    ((b.confidence || 0) - (a.confidence || 0)) ||
    String(a.name).localeCompare(b.name)
  );

  const byClass = merged.reduce((acc, m) => {
    const k = m.classification || "unclassified";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  const out = {
    ...store,
    competitors: merged,
    retired,
    by_classification: byClass,
    high_threat_count: merged.filter(m => (m.threat_score || 0) >= 70).length,
    reassessed_at: new Date().toISOString(),
  };
  writeJson(OUT, out);
  writeJson(DATA_OUT, out);

  console.log(`\n  assessed: ${ok} · unreachable: ${unreachable} · retired: ${retired.length}`);
  for (const r of retired.slice(-6)) console.log(`    retired  ${String(r.name).padEnd(24)} ${r.reason}`);
  console.log(`  ${Object.entries(byClass).map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  console.log(`  written to store/competitors.json and data/competitors.json\n`);
})();
