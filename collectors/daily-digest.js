#!/usr/bin/env node
/**
 * Daily new-competitor monitor (requirement 6).
 *
 *   node collectors/daily-digest.js run        one pass now
 *   node collectors/daily-digest.js schedule   stay resident, run once per day
 *   node collectors/daily-digest.js status     what the last run did
 *   node collectors/daily-digest.js preview    render today's digest without sending
 *
 * THE PROPERTY THAT MAKES A DAILY EMAIL USEFUL RATHER THAN NOISE
 * -------------------------------------------------------------
 * "Avoid reporting unchanged discoveries repeatedly." A digest that re-lists the
 * same six products every morning gets filtered within a week, so the state file
 * records every domain already reported. A product appears in the email exactly
 * once — unless something material changed, in which case it reappears WITH the
 * change named (a threat score that moved, or a reclassification). Everything
 * else is summarised as a count, not a list.
 *
 * DELIVERY
 * --------
 * Sends to DIGEST_TO via SMTP when configured. When it is not, the digest is
 * still generated and stored under data/digests/, the dashboard shows it, and
 * the exact missing configuration is reported — never a silent no-op, and never
 * a claim that mail was sent.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { load } = require("./lib/env");
const { readJson, writeJson, STORE_DIR } = require("./lib/store");
const mailer = require("./lib/mailer");
const webhook = require("./lib/webhook");

load();

const ROOT = path.join(__dirname, "..");
const DIGEST_DIR = path.join(ROOT, "data", "digests");
const STATE = path.join(STORE_DIR, "digest-state.json");
const COMPETITORS = path.join(STORE_DIR, "competitors.json");
const DIRECTORY_LISTINGS = path.join(STORE_DIR, "directory-listings.json");
const LATEST = path.join(ROOT, "data", "digest-latest.json");

/** Material change worth re-reporting a known product for. */
const THREAT_MOVE = 10;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function readState() {
  return readJson(STATE, { reported: {}, runs: [], last_run_at: null });
}

/* ------------------------------------------------------------------ discovery */

/**
 * Run a --recent discovery sweep as a child process.
 * Kept as a subprocess deliberately: the discovery collector is a script with
 * its own cursor persistence and process lifetime, and re-entering it in-process
 * would risk two writers on the cursor file.
 */
function spawnCollector(script, args, label, { log = () => {} } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, script), ...args], { cwd: ROOT });
    let out = "";
    child.stdout.on("data", d => { out += d.toString(); });
    child.stderr.on("data", d => { out += d.toString(); });
    child.on("close", code => {
      log(`    ${label} exited ${code}`);
      resolve({ ok: code === 0, code, output: out });
    });
    child.on("error", e => resolve({ ok: false, code: -1, output: String(e.message) }));
  });
}

function runDiscovery({ keywords = 20, log = () => {} } = {}) {
  return spawnCollector("discover-competitors.js", [`--keywords=${keywords}`, "--recent"], "web discovery", { log });
}

/**
 * The review-directory audit, run as part of the daily job.
 *
 * Without this the digest would only re-read whatever the last manual audit
 * produced, so a product listed on G2 today would not appear until someone ran
 * the collector by hand — which defeats the point of a daily monitor.
 *
 * It is a subprocess for the same reason web discovery is: both own a state
 * file, and two writers would race.
 */
function runDirectoryAudit({ log = () => {} } = {}) {
  return spawnCollector("directory-audit.js", ["--resolve"], "directory audit", { log });
}

/* --------------------------------------------------------------------- digest */

/**
 * New product listings on the review directories, diffed the same way as
 * web-discovered competitors: reported once, then counted rather than re-listed.
 *
 * Kept as a separate section because it is a different kind of finding. A web
 * discovery is a product that exists; a directory listing is a product that has
 * entered a buyer's comparison set — which is what makes it worth a daily look.
 */
function directorySection(state, { log = () => {} } = {}) {
  const d = readJson(DIRECTORY_LISTINGS, null);
  if (!d || d.status !== "audited") {
    return {
      available: false,
      reason: "No directory audit has run yet — run: npm run directories",
    };
  }

  const reported = state.reported_listings || {};
  const brandNew = [];
  let unchanged = 0;

  for (const p of d.products || []) {
    const key = "dir:" + require("./lib/directories").norm(p.product);
    if (reported[key]) { unchanged++; continue; }
    brandNew.push(p);
  }

  // Multi-directory listings first: appearing on several is corroboration that
  // the product is genuinely being evaluated, not just indexed once.
  brandNew.sort((a, b) =>
    (b.directories.length - a.directories.length) ||
    ((b.threat_score || 0) - (a.threat_score || 0)) ||
    (b.confidence - a.confidence));

  log(`    directories: ${brandNew.length} new listing(s), ${unchanged} already reported`);

  return {
    available: true,
    audited_at: d.audited_at,
    directories_audited: d.directories_audited,
    categories_audited: d.categories_audited,
    total_products: (d.products || []).length,
    new_count: brandNew.length,
    unchanged_count: unchanged,
    per_category: d.per_category,
    per_directory: d.per_directory,
    new_listings: brandNew.map(p => ({
      product: p.product,
      name_source: p.name_source,
      categories: (p.categories || []).map(c => c.label),
      directories: (p.listings || []).map(l => ({ label: l.directory_label, url: l.url })),
      directory_count: p.directories.length,
      website: p.website,
      website_status: p.website_status,
      company: p.company || null,
      description: p.description || null,
      classification: p.classification || null,
      threat_score: p.threat_score ?? null,
      why_it_could_compete: p.why_it_could_compete || null,
      // Carried through so the email can warn where the directory listing and
      // the resolved homepage disagree — the reader should trust neither yet.
      source_conflict: p.source_conflict || null,
      confidence: Math.round((p.confidence || 0) * 100),
      confidence_basis: p.confidence_basis || [],
      first_seen: p.first_seen,
    })),
    // Precision, kept visible so the numbers can be trusted.
    excluded_count: (d.totals || {}).excluded || 0,
    category_unconfirmed_count: (d.totals || {}).category_unconfirmed || 0,
    method: d.method,
    access_method: d.access_method,
  };
}

function buildDigest({ log = () => {} } = {}) {
  const comp = readJson(COMPETITORS, null);
  if (!comp || comp.status !== "scanned") {
    return { ok: false, error: "No competitor scan available — discovery has not produced data." };
  }

  const state = readState();
  const all = comp.competitors || [];

  const brandNew = [];
  const changed = [];
  const unchanged = [];

  for (const c of all) {
    // Only genuine competitors reach the email. A "not_a_competitor" row is kept
    // in the dashboard for auditability but would be noise in a daily summary.
    if (c.classification === "not_a_competitor") continue;

    const prior = state.reported[c.domain];
    if (!prior) {
      brandNew.push(c);
      continue;
    }
    const scoreMove = Math.abs((c.threat_score || 0) - (prior.threat_score || 0));
    const reclassified = c.classification && prior.classification && c.classification !== prior.classification;
    if (reclassified || scoreMove >= THREAT_MOVE) {
      changed.push({
        ...c,
        change: reclassified
          ? `reclassified from ${label(prior.classification)} to ${label(c.classification)}`
          : `threat score moved ${prior.threat_score} → ${c.threat_score}`,
        previous: { threat_score: prior.threat_score, classification: prior.classification },
      });
    } else {
      unchanged.push(c);
    }
  }

  // Highest threat first — the ordering the reader needs.
  const bySeverity = (a, b) => (b.threat_score || 0) - (a.threat_score || 0);
  brandNew.sort(bySeverity);
  changed.sort(bySeverity);

  const highThreat = [...brandNew, ...changed].filter(c => (c.threat_score || 0) >= 70);
  const dirSection = directorySection(state, { log });

  const digest = {
    date: today(),
    generated_at: new Date().toISOString(),
    // The headline: is there anything to act on? Directory listings count —
    // a product entering a buyer's comparison set is actionable.
    actionable: brandNew.length + changed.length + (dirSection.available ? dirSection.new_count : 0),
    new_count: brandNew.length,
    changed_count: changed.length,
    unchanged_count: unchanged.length,
    high_threat_count: highThreat.length,
    total_tracked: all.filter(c => c.classification !== "not_a_competitor").length,

    new_competitors: brandNew.map(summarise),
    changed_competitors: changed.map(c => ({ ...summarise(c), change: c.change, previous: c.previous })),

    // Deliberately a count, not a list — that is what stops the repetition.
    unchanged_note: unchanged.length
      ? `${unchanged.length} previously reported product(s) unchanged since the last digest and not re-listed.`
      : null,

    // Review-directory listings — a separate finding type, reported separately.
    directories: dirSection,

    scan: {
      scanned_at: comp.scanned_at,
      keywords_this_run: comp.keywords_this_run || [],
      keyword_sweep: `${comp.cursor_index || 0}/${comp.keywords_total || 0}`,
      candidates_examined: comp.candidates_examined || 0,
      rejected: (comp.rejected_this_run || []).length,
      provider: comp.provider || null,
      recent_mode: !!comp.recent_mode,
    },
    method: comp.method,
  };

  log(`    ${digest.new_count} new, ${digest.changed_count} changed, ${digest.unchanged_count} unchanged`);
  return { ok: true, digest, brandNew, changed, dirNew: dirSection.available ? dirSection.new_listings : [] };
}

function label(c) {
  return {
    direct_competitor: "Direct competitor",
    adjacent_competitor: "Adjacent competitor",
    emerging_competitor: "Emerging competitor",
    not_a_competitor: "Not a competitor",
  }[c] || c || "unclassified";
}

/** The fields requirement 5 asks to be shown, with evidence attached. */
function summarise(c) {
  return {
    product: c.name,
    company: c.company || null,
    company_note: c.company ? null : "not published on the site",
    website: c.website,
    domain: c.domain,
    description: c.description || null,
    category: (c.categories || [])[0] || null,
    categories: c.categories || [],
    classification: c.classification || null,
    classification_label: label(c.classification),
    classification_basis: c.classification_basis || null,
    threat_score: c.threat_score ?? null,
    threat_band: c.threat_band || null,
    why_it_could_compete: c.why_it_could_compete || null,
    launch_date: c.launch_date || null,
    launch_date_basis: c.launch_date_basis || null,
    discovered_at: c.first_seen || null,
    // Distinguishing these two is the point: a launch date we could not
    // establish is not the same as the day we happened to find the product.
    date_note: c.launch_date
      ? `Launch date from the site itself (${c.launch_date_precision} precision).`
      : "No launch date published on the site; only the discovery date is known.",
    evidence_url: c.evidence_url || c.website,
    found_via_url: c.found_via_url || null,
    confidence: c.confidence != null ? Math.round(c.confidence * 100) : null,
    assessment_confidence: c.assessment_confidence != null ? Math.round(c.assessment_confidence * 100) : null,
    signals: (c.threat_signals || []).map(s => ({
      label: s.label,
      contributed: s.contributed,
      matched: (s.evidence || []).map(e => e.matched).slice(0, 3),
    })),
  };
}

/* ------------------------------------------------------------------ rendering */

function renderText(d) {
  const L = [];
  L.push(`Document360 — Daily New-Competitor Digest`);
  L.push(`${d.date}`);
  L.push("");
  if (!d.actionable) {
    L.push(`No new or materially changed competitors today.`);
    L.push(`${d.total_tracked} product(s) tracked; ${d.unchanged_count} unchanged and not re-listed.`);
    L.push("");
    L.push(`Scan: ${d.scan.candidates_examined} candidate domain(s) examined, ${d.scan.rejected} rejected.`);
    L.push(`Keyword sweep at ${d.scan.keyword_sweep}.`);
    return L.join("\n");
  }

  L.push(`${d.new_count} new · ${d.changed_count} changed · ${d.high_threat_count} high threat`);
  L.push("");

  for (const c of d.new_competitors) {
    L.push(`── NEW · threat ${c.threat_score}/100 (${c.threat_band}) · ${c.classification_label}`);
    L.push(`   ${c.product}${c.company && c.company !== c.product ? `  (${c.company})` : ""}`);
    L.push(`   ${c.website}`);
    if (c.description) L.push(`   ${c.description.slice(0, 180)}`);
    L.push(`   Why it could compete: ${c.why_it_could_compete}`);
    L.push(`   Basis: ${c.classification_basis}`);
    L.push(`   ${c.launch_date ? `Launched ${c.launch_date}` : "Launch date unknown"} · discovered ${String(c.discovered_at).slice(0, 10)}`);
    L.push(`   Evidence: ${c.evidence_url}`);
    L.push(`   Confidence: ${c.assessment_confidence}% on the assessment, ${c.confidence}% that it is a genuine entrant`);
    L.push("");
  }

  for (const c of d.changed_competitors) {
    L.push(`── CHANGED · ${c.change}`);
    L.push(`   ${c.product} — ${c.website}`);
    L.push(`   Now: threat ${c.threat_score}/100, ${c.classification_label}`);
    L.push(`   ${c.classification_basis}`);
    L.push("");
  }

  /* ------------------------------------------------- directory listings */
  const dir = d.directories || {};
  if (dir.available && dir.new_count) {
    L.push("");
    L.push(`── NEW ON REVIEW DIRECTORIES (${dir.new_count})`);
    L.push(`   ${dir.total_products} product(s) currently listed across ${(dir.directories_audited || []).length} directories`);
    L.push("");
    for (const p of dir.new_listings.slice(0, 20)) {
      L.push(`   ${p.product}${p.company && p.company !== p.product ? `  (${p.company})` : ""}`);
      L.push(`     categories: ${p.categories.join(", ")}`);
      L.push(`     listed on:  ${p.directories.map(x => x.label).join(", ")}${p.directory_count > 1 ? `  [${p.directory_count} directories]` : ""}`);
      if (p.website) L.push(`     website:    ${p.website}${p.threat_score != null ? `   threat ${p.threat_score}/100 (${p.classification})` : ""}`);
      else L.push(`     website:    ${p.website_status}`);
      if (p.why_it_could_compete) L.push(`     why:        ${p.why_it_could_compete.slice(0, 150)}`);
      if (p.source_conflict) {
        // The reader must not take either the score or the URL at face value.
        L.push(`     ⚠ CONFLICT:  ${p.source_conflict.detail}`);
      }
      L.push(`     evidence:   ${p.directories[0].url}`);
      L.push(`     confidence: ${p.confidence}% — ${(p.confidence_basis || [])[0] || ""}`);
      L.push("");
    }
    if (dir.new_listings.length > 20) L.push(`   … ${dir.new_listings.length - 20} more`);
    if (dir.unchanged_count) L.push(`   ${dir.unchanged_count} listing(s) already reported and not repeated.`);
    L.push(`   ${dir.excluded_count} excluded as tracked/incumbent · ${dir.category_unconfirmed_count} found but not category-confirmed.`);
  } else if (dir.available) {
    L.push("");
    L.push(`Review directories: no new listings. ${dir.total_products} product(s) tracked, ${dir.unchanged_count} unchanged.`);
  }

  if (d.unchanged_note) L.push(d.unchanged_note);
  L.push("");
  L.push(`Scan: ${d.scan.candidates_examined} candidate domain(s), ${d.scan.rejected} rejected. Sweep ${d.scan.keyword_sweep}.`);
  L.push(`Every product above is a homepage this system fetched; names, descriptions and`);
  L.push(`threat signals come from that page's own words. Nothing is inferred from the`);
  L.push(`search keyword alone.`);
  return L.join("\n");
}

function renderHtml(d) {
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const band = b => ({ high: "#c0392b", medium: "#e8a317", low: "#5a5a6e", minimal: "#8a8a9a" }[b] || "#5a5a6e");

  const card = (c, kind) => `
    <tr><td style="padding:14px 16px;border:1px solid #e6e4ee;border-radius:10px;background:#fff">
      <div style="font:600 11px/1.4 -apple-system,Segoe UI,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:${band(c.threat_band)}">
        ${kind} · threat ${c.threat_score}/100 · ${esc(c.classification_label)}
      </div>
      <div style="font:650 16px/1.4 -apple-system,Segoe UI,sans-serif;color:#14121f;margin-top:6px">
        ${esc(c.product)}${c.company && c.company !== c.product ? ` <span style="font-weight:400;color:#6b6880">· ${esc(c.company)}</span>` : ""}
      </div>
      <div style="font:400 12px/1.4 -apple-system,Segoe UI,sans-serif;margin-top:2px">
        <a href="${esc(c.website)}" style="color:#6c4bd8">${esc(c.domain)}</a>
      </div>
      ${c.description ? `<div style="font:400 13px/1.55 -apple-system,Segoe UI,sans-serif;color:#3d3a4d;margin-top:8px">${esc(c.description.slice(0, 200))}</div>` : ""}
      ${c.change ? `<div style="font:600 12px/1.5 -apple-system,Segoe UI,sans-serif;color:#e8a317;margin-top:8px">${esc(c.change)}</div>` : ""}
      <div style="font:400 12.5px/1.55 -apple-system,Segoe UI,sans-serif;color:#3d3a4d;margin-top:8px;padding-left:10px;border-left:2px solid #e6e4ee">
        <b>Why it could compete:</b> ${esc(c.why_it_could_compete)}
      </div>
      <div style="font:400 11.5px/1.5 -apple-system,Segoe UI,sans-serif;color:#6b6880;margin-top:8px">
        ${esc(c.classification_basis)}
      </div>
      <div style="font:400 11px/1.5 -apple-system,Segoe UI,sans-serif;color:#8a8a9a;margin-top:8px">
        ${c.launch_date ? `Launched ${esc(c.launch_date)}` : "Launch date not published"} ·
        discovered ${esc(String(c.discovered_at).slice(0, 10))} ·
        assessment confidence ${c.assessment_confidence}% ·
        <a href="${esc(c.evidence_url)}" style="color:#6b6880">evidence</a>
      </div>
    </td></tr><tr><td style="height:10px"></td></tr>`;

  return `<div style="background:#f6f5fa;padding:22px;font-family:-apple-system,Segoe UI,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:660px;margin:0 auto">
    <tr><td style="padding-bottom:16px">
      <div style="font:700 18px/1.3 -apple-system,Segoe UI,sans-serif;color:#14121f">Daily New-Competitor Digest</div>
      <div style="font:400 13px/1.5 -apple-system,Segoe UI,sans-serif;color:#6b6880;margin-top:3px">
        Document360 Competitive Intelligence · ${esc(d.date)}
      </div>
    </td></tr>
    ${!d.actionable ? `
    <tr><td style="padding:16px;border:1px solid #e6e4ee;border-radius:10px;background:#fff;font:400 14px/1.6 -apple-system,Segoe UI,sans-serif;color:#3d3a4d">
      No new or materially changed competitors today.
      <div style="color:#6b6880;font-size:12.5px;margin-top:6px">
        ${d.total_tracked} product(s) tracked · ${d.unchanged_count} unchanged and not re-listed ·
        ${d.scan.candidates_examined} candidate domain(s) examined, ${d.scan.rejected} rejected.
      </div>
    </td></tr>` : `
    <tr><td style="padding-bottom:12px;font:600 13px/1.5 -apple-system,Segoe UI,sans-serif;color:#3d3a4d">
      ${d.new_count} new · ${d.changed_count} changed · ${d.high_threat_count} high threat
    </td></tr>
    ${d.new_competitors.map(c => card(c, "NEW")).join("")}
    ${d.changed_competitors.map(c => card(c, "CHANGED")).join("")}
    ${d.unchanged_note ? `<tr><td style="font:400 12px/1.5 -apple-system,Segoe UI,sans-serif;color:#8a8a9a;padding-top:4px">${esc(d.unchanged_note)}</td></tr>` : ""}`}
    <tr><td style="padding-top:18px;font:400 11px/1.6 -apple-system,Segoe UI,sans-serif;color:#8a8a9a;border-top:1px solid #e6e4ee">
      Every product listed is a homepage this system fetched. Names, descriptions and threat
      signals come from that page's own words — nothing is inferred from the search keyword
      alone, and no figure here is estimated. Keyword sweep at ${esc(d.scan.keyword_sweep)}.
    </td></tr>
  </table></div>`;
}

/* ---------------------------------------------------------------------- run */

async function run({ keywords = 20, discover = true, log = console.log } = {}) {
  log(`\nDaily new-competitor monitor — ${today()}`);

  if (discover) {
    log("  ▸ web discovery sweep (recent-launch mode)");
    const d = await runDiscovery({ keywords, log });
    if (!d.ok) log(`    ! web discovery failed; using the last stored scan`);

    log("  ▸ review-directory audit (7 directories × 6 categories)");
    const a = await runDirectoryAudit({ log });
    if (!a.ok) log(`    ! directory audit failed; using the last stored audit`);
  } else {
    log("  ▸ collection skipped (--no-discover); using the last stored scan and audit");
  }

  log("  ▸ diffing against previously reported products");
  const built = buildDigest({ log });
  if (!built.ok) {
    log(`  ! ${built.error}`);
    return { ok: false, error: built.error };
  }
  const { digest, brandNew, changed } = built;
  // `built` itself is referenced later for the directory-listing state update.

  /* ------------------------------------------------------------- persist */
  fs.mkdirSync(DIGEST_DIR, { recursive: true });
  const file = path.join(DIGEST_DIR, `${digest.date}.json`);

  /* -------------------------------------------------------------- deliver */
  const mail = mailer.status();
  let delivery;
  if (!digest.actionable && process.argv.includes("--only-when-actionable")) {
    delivery = { attempted: false, reason: "nothing actionable today and --only-when-actionable was set" };
    log("  ▸ nothing actionable — email suppressed by flag");
  } else if (mail.configured) {
    log(`  ▸ emailing ${mail.to}`);
    const sent = await mailer.send({
      subject: digest.actionable
        ? `[D360 CI] ${digest.new_count} new competitor(s)${digest.high_threat_count ? `, ${digest.high_threat_count} high threat` : ""} — ${digest.date}`
        : `[D360 CI] No new competitors — ${digest.date}`,
      text: renderText(digest),
      html: renderHtml(digest),
    });
    delivery = { attempted: true, ...sent };
    log(sent.delivered ? `    delivered to ${sent.to}` : `    ! delivery failed: ${sent.error || sent.reason}`);
  } else {
    delivery = {
      attempted: false,
      delivered: false,
      reason: mail.requirement,
      missing_config: mail.missing,
    };
    log(`  ▸ email NOT configured — digest stored but not sent`);
    log(`    missing: ${mail.missing.join(", ")}`);
  }

  const record = { ...digest, delivery, rendered_text: renderText(digest) };
  writeJson(file, record);
  writeJson(LATEST, record);

  /* ------------------------------------------------- webhook notification */
  // The webhook is a second, independent channel; a configured webhook means the
  // team can be notified even with no SMTP.
  if (digest.actionable) {
    try {
      const w = await webhook.deliver("new_competitor", {
        date: digest.date,
        new_count: digest.new_count,
        changed_count: digest.changed_count,
        high_threat_count: digest.high_threat_count,
        competitors: digest.new_competitors.map(c => ({
          product: c.product, website: c.website, threat_score: c.threat_score,
          classification: c.classification, why: c.why_it_could_compete, evidence_url: c.evidence_url,
        })),
      });
      if (w && w.ok) log("  ▸ webhook notified");
    } catch (e) { /* webhook not configured is normal */ }
  }

  /* ---------------------------------------------------------- state update */
  // Record what was reported so tomorrow does not repeat it. Only products that
  // actually appeared in this digest are marked — a delivery failure must not
  // suppress them from the next attempt.
  const state = readState();
  if (delivery.delivered || !mail.configured) {
    for (const c of [...brandNew, ...changed]) {
      state.reported[c.domain] = {
        first_reported: (state.reported[c.domain] || {}).first_reported || digest.date,
        last_reported: digest.date,
        threat_score: c.threat_score ?? null,
        classification: c.classification || null,
      };
    }
    // Directory listings are keyed by normalised product name, not domain: the
    // same product appears on several directories and most have no website
    // resolved, so a domain key would either split or drop them.
    state.reported_listings = state.reported_listings || {};
    const norm = require("./lib/directories").norm;
    for (const p of (built.dirNew || [])) {
      const key = "dir:" + norm(p.product);
      state.reported_listings[key] = {
        product: p.product,
        first_reported: (state.reported_listings[key] || {}).first_reported || digest.date,
        last_reported: digest.date,
        directories: p.directories.map(x => x.label),
        categories: p.categories,
      };
    }
  }
  state.last_run_at = new Date().toISOString();
  state.runs = [
    {
      date: digest.date,
      at: state.last_run_at,
      new_count: digest.new_count,
      changed_count: digest.changed_count,
      delivered: !!delivery.delivered,
    },
    ...(state.runs || []),
  ].slice(0, 60);
  writeJson(STATE, state);

  log(`  ▸ stored ${path.relative(ROOT, file)}\n`);
  return { ok: true, digest, delivery, file };
}

/* ------------------------------------------------------------------ schedule */

/**
 * Resident scheduler: runs at the start of each local day.
 *
 * A resident loop is the zero-dependency option and needs no admin rights, but
 * it only runs while the process is alive. For a genuinely unattended daily job
 * the Windows Task Scheduler command is printed, because that survives logout
 * and reboot and this loop does not.
 */
function schedule({ hour = 7, keywords = 20 } = {}) {
  console.log(`\nDaily monitor scheduled for ${String(hour).padStart(2, "0")}:00 local, every day.`);
  console.log("This process must stay running. For an unattended job that survives reboot:");
  console.log(`\n  schtasks /Create /SC DAILY /ST ${String(hour).padStart(2, "0")}:00 /TN "D360 Competitor Digest" ^\n    /TR "\\"${process.execPath}\\" \\"${path.join(__dirname, "daily-digest.js")}\\" run"\n`);

  const state = readState();
  let lastRunDate = (state.runs && state.runs[0] && state.runs[0].date) || null;

  const tick = async () => {
    const now = new Date();
    const d = now.toISOString().slice(0, 10);
    if (d !== lastRunDate && now.getHours() >= hour) {
      lastRunDate = d;
      try { await run({ keywords }); } catch (e) { console.error("  ! digest run failed: " + e.message); }
    }
  };

  tick();
  // Check every 10 minutes: cheap, and tolerant of the machine sleeping through
  // the exact scheduled minute.
  setInterval(tick, 10 * 60 * 1000);
}

/* --------------------------------------------------------------------- CLI */

if (require.main === module) {
  const cmd = process.argv[2] || "run";
  const arg = (k, d) => {
    const a = process.argv.find(x => x.startsWith(`--${k}=`));
    return a ? a.split("=")[1] : d;
  };

  if (cmd === "run") {
    run({
      keywords: parseInt(arg("keywords", "20"), 10),
      discover: !process.argv.includes("--no-discover"),
    }).then(r => process.exit(r.ok ? 0 : 1));
  } else if (cmd === "schedule") {
    schedule({ hour: parseInt(arg("hour", "7"), 10), keywords: parseInt(arg("keywords", "20"), 10) });
  } else if (cmd === "preview") {
    const b = buildDigest({ log: console.log });
    if (!b.ok) { console.error("  ! " + b.error); process.exit(1); }
    console.log("\n" + renderText(b.digest) + "\n");
    console.log("email: " + JSON.stringify(mailer.status(), null, 2));
  } else if (cmd === "status") {
    const s = readState();
    console.log(JSON.stringify({
      last_run_at: s.last_run_at,
      products_already_reported: Object.keys(s.reported).length,
      recent_runs: (s.runs || []).slice(0, 10),
      email: mailer.status(),
    }, null, 2));
  } else {
    console.log("usage: node collectors/daily-digest.js run | schedule | preview | status");
  }
}

module.exports = { run, buildDigest, renderText, renderHtml, schedule, LATEST, DIGEST_DIR };
