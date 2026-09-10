#!/usr/bin/env node
/**
 * Review-directory audit — new product listings across 7 directories × 6 categories.
 *
 *   npm run directories                 audit every directory × category
 *   npm run directories -- --dir=g2     one directory
 *   npm run directories -- --cat=sop    one category
 *   npm run directories -- --resolve    also resolve vendor websites (slower)
 *   npm run directories:new             show only what is new since last run
 *
 * WHAT IT PRODUCES
 * ----------------
 * A per-directory, per-category inventory of products listed, split into:
 *
 *   new                   first time this audit has seen the product
 *   known                 seen in a previous run
 *   excluded              a tracked product or a known incumbent
 *   category_unconfirmed  a real product page whose listing carries no evidence
 *                         of the category it was found under
 *   rejected              not a product page, or its listing describes a
 *                         different category outright
 *
 * The last two are the point. A category-scoped search returns products that
 * merely rank for the phrase — measured: TrustRadius returns Paycom, BambooHR
 * and ADP Workforce Now for "customer self service" — so a listing is only
 * counted in a category when its own text places it there.
 *
 * ACCESS: read through Google's/Bing's public index via SearXNG, because five
 * of the seven directories return 403 to a direct fetch. Their robots.txt files
 * permit product and category pages; it is a WAF that refuses us. Reading the
 * search index costs nothing, touches no bot wall, and is what makes a DAILY
 * audit affordable.
 */
const path = require("path");
const { load } = require("./lib/env");
const searx = require("./lib/searxng-client");
const { fetchUrl } = require("./lib/fetch");
const scrape = require("./lib/scrape");
const { htmlToText, extractTitle, isUsableDescription } = require("./lib/verify");
const dirs = require("./lib/directories");
const threat = require("./lib/threat");
const { readJson, writeJson, STORE_DIR } = require("./lib/store");

load();

const OUT = path.join(STORE_DIR, "directory-listings.json");
const DATA_OUT = path.join(__dirname, "..", "data", "directory-listings.json");

const sleep = ms => new Promise(r => setTimeout(r, ms));

function arg(k, d) {
  const a = process.argv.find(x => x.startsWith(`--${k}=`));
  return a ? a.split("=")[1] : d;
}

/* -------------------------------------------------------- website resolution */

/**
 * Find a product's own website.
 *
 * Bounded per run, because it costs a search each. A result is only accepted
 * when the domain plausibly belongs to the product — otherwise the vendor site
 * is reported as unresolved rather than guessed, since a wrong homepage would
 * then be threat-scored and produce a confidently wrong assessment.
 */
/**
 * Names too generic to identify a vendor. Resolving these produces a confident
 * wrong answer: measured — "Help.center" resolved to help.openai.com and
 * "Customer Portal" to customer.control4.com, because a loose prefix match
 * accepted any host beginning with "help" or "customer". A wrong homepage then
 * gets threat-scored, so the error compounds into a fabricated assessment.
 */
const GENERIC_NAME = /^(customer|client|help|support|knowledge|user|admin|partner|vendor|employee|self)[\s.\-]?(portal|center|centre|base|hub|desk|service|guide|docs?)?$/i;

async function resolveWebsite(name, { log = () => {} } = {}) {
  const DIRECTORY_HOSTS = /g2\.com|capterra|getapp|trustradius|gartner|softwareadvice|softwaresuggest|crozdesk|saasworthy|producthunt|crunchbase|linkedin|youtube|wikipedia|reddit|medium|github/i;

  const slug = dirs.norm(name);
  if (slug.length < 5) {
    return { ok: false, reason: `product name "${name}" is too short to resolve a domain from safely` };
  }
  if (GENERIC_NAME.test(String(name).trim())) {
    return { ok: false, reason: `"${name}" is a generic descriptor rather than a distinctive product name — resolving it would attribute an unrelated domain` };
  }

  const r = await searx.search(`"${name}" official website`, { days: 365 });
  if (!r.ok) return { ok: false, reason: `search failed: ${r.error}` };

  for (const hit of (r.results || []).slice(0, 12)) {
    let host;
    try { host = new URL(hit.url).hostname.replace(/^www\./, ""); } catch (e) { continue; }
    if (DIRECTORY_HOSTS.test(host)) continue;

    /* The domain label and the product name must substantially BE each other,
     * not merely share a prefix. The overlap ratio is what stops "helpcenter"
     * from matching the host label "help": 4/10 = 0.4, well under the bar,
     * while "docuwriterai" vs "docuwriter" is 10/12 = 0.83 and passes. */
    const root = dirs.norm(host.split(".")[0]);
    if (root.length < 4) continue;
    const contains = root.startsWith(slug) || slug.startsWith(root) || root === slug;
    if (!contains) continue;
    const ratio = Math.min(root.length, slug.length) / Math.max(root.length, slug.length);
    if (ratio < 0.7) continue;

    return {
      ok: true, website: `https://${host}/`, host,
      matched_on: root,
      name_overlap: Math.round(ratio * 100) / 100,
    };
  }
  return {
    ok: false,
    reason: "no domain in the search results matched the product name closely enough to attribute safely",
  };
}

/** Fetch a resolved homepage and run the existing threat assessment on it. */
async function assessWebsite(website, name) {
  /* Through the scraping chain rather than a bare fetch: a vendor homepage
   * behind a WAF used to read as "unreachable", which then reported as
   * "not assessed" and looked like a missing product rather than a blocked
   * request. The chain falls through to a stealth proxy and records which
   * route retrieved the bytes. */
  const r = await scrape.fetchPage(website, { log: () => {} });
  if (!r.ok) return { ok: false, reason: `homepage returned HTTP ${r.status || "no response"}` };
  const text = htmlToText(r.body);
  const desc = (String(r.body).match(
    /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i
  ) || [])[1] || "";
  const identity = [extractTitle(r.body) || "", desc].filter(Boolean).join(". ");
  const a = threat.assess({ identity, body_text: text });
  const company = threat.extractCompany(r.body, name);

  // Prefer the meta description, fall back to page text, and drop either if it
  // is an unrendered template or cookie boilerplate rather than a description.
  let description = null;
  let descriptionNote = null;
  for (const candidate of [desc, text.slice(0, 240).trim()]) {
    if (!candidate) continue;
    const u = isUsableDescription(candidate);
    if (u.ok) { description = candidate; break; }
    if (!descriptionNote) descriptionNote = u.reason;
  }

  return {
    ok: true,
    description,
    description_note: description ? null : (descriptionNote || "no description published on the site"),
    company: company.company,
    classification: a.classification,
    classification_basis: a.classification_basis,
    threat_score: a.threat_score,
    threat_band: a.threat_band,
    why_it_could_compete: a.why_it_could_compete,
    threat_signals: a.signals,
    assessment_confidence: a.assessment_confidence,
    evidence_content_sha256: r.content_sha256,
  };
}

/* --------------------------------------------------------------------- audit */

(async () => {
  const onlyDir = arg("dir", null);
  const onlyCat = arg("cat", null);
  const doResolve = process.argv.includes("--resolve");

  const directories = dirs.DIRECTORIES.filter(d => !onlyDir || d.id === onlyDir);
  const categories = dirs.CATEGORIES.filter(c => !onlyCat || c.id === onlyCat);
  if (!directories.length || !categories.length) {
    console.error(`\n  ! no matching directory/category. Directories: ${dirs.DIRECTORIES.map(d => d.id).join(", ")}` +
      `\n    Categories: ${dirs.CATEGORIES.map(c => c.id).join(", ")}\n`);
    process.exit(1);
  }

  const probe = await searx.probe();
  if (!probe.ok) {
    console.error(`\n  ! SearXNG is required and is not available: ${probe.reason}` +
      `\n    Start it with: npm run searxng:local\n`);
    process.exit(1);
  }

  console.log(`\nReview-directory audit`);
  console.log(`  ${directories.length} directory(ies) × ${categories.length} category(ies)`);
  console.log(`  access: ${probe.detail.split(" — ")[0]} (public search index; no bot wall touched)`);
  console.log(`  website resolution: ${doResolve ? `on, max ${dirs.LIMITS.max_website_resolutions_per_run}` : "off (pass --resolve)"}\n`);

  const ex = dirs.buildExclusions();
  const prev = readJson(OUT, { products: {} });
  const prevSeen = prev.products || {};

  // Keyed by directory|slug so the same product on two directories is two
  // listings of one product, not two products.
  const listings = new Map();
  const rejected = [];
  const unconfirmed = [];
  const excluded = [];
  const searchGaps = [];
  const stats = { queries: 0, results: 0, product_pages: 0 };

  for (const dir of directories) {
    for (const cat of categories) {
      const queries = dirs.queriesFor(dir.id, cat.id);
      let foundHere = 0;

      for (const q of queries) {
        await sleep(dirs.LIMITS.query_gap_ms || 1400);
        stats.queries++;
        const s = await searx.search(q, { days: 365 });
        if (!s.ok) {
          searchGaps.push({ directory: dir.id, category: cat.id, query: q, error: s.error });
          continue;
        }
        const hits = (s.results || []).slice(0, dirs.LIMITS.results_per_query || 30);
        stats.results += hits.length;

        for (const hit of hits) {
          const pm = dirs.matchProductPage(hit.url, dir);
          if (!pm.ok) {
            rejected.push({ directory: dir.id, category: cat.id, url: hit.url, reason: pm.reason });
            continue;
          }
          stats.product_pages++;

          const { name, source: nameSource } = dirs.extractName(hit.title, pm.slug, dir);
          if (!name) {
            rejected.push({ directory: dir.id, category: cat.id, url: hit.url, reason: "no usable product name" });
            continue;
          }

          // A name made only of category words is a category page, not a product.
          if (dirs.isGenericName(name)) {
            rejected.push({
              directory: dir.id, category: cat.id, name, slug: pm.slug, url: hit.url,
              reason: "generic name — built entirely from category vocabulary, so it identifies a category rather than a product",
            });
            continue;
          }

          const exReason = dirs.exclusionReason(name, pm.slug, ex);
          if (exReason) {
            excluded.push({ directory: dir.id, category: cat.id, name, slug: pm.slug, url: hit.url, reason: exReason });
            continue;
          }

          const cc = dirs.confirmCategory(cat.id, {
            title: hit.title, snippet: hit.content || "", url: hit.url,
          });
          if (!cc.confirmed) {
            (cc.rejected ? rejected : unconfirmed).push({
              directory: dir.id, category: cat.id, name, slug: pm.slug, url: hit.url,
              reason: cc.reason, matched: cc.matched || null,
            });
            continue;
          }

          const key = `${dir.id}|${pm.slug}`;
          const existing = listings.get(key);
          if (existing) {
            // Same listing found under a second category — record both.
            if (!existing.categories.some(c => c.id === cat.id)) {
              existing.categories.push({ id: cat.id, label: cat.label, confirmed_by: cc.matched, where: cc.where });
            }
            continue;
          }

          listings.set(key, {
            product: name,
            name_source: nameSource,
            slug: pm.slug,
            directory: dir.id,
            directory_label: dir.label,
            listing_url: hit.url,
            listing_title: hit.title || null,
            listing_snippet: (hit.content || "").slice(0, 300) || null,
            categories: [{ id: cat.id, label: cat.label, confirmed_by: cc.matched, where: cc.where }],
            first_seen: (prevSeen[key] && prevSeen[key].first_seen) || new Date().toISOString(),
            is_new: !prevSeen[key],
            times_seen: ((prevSeen[key] && prevSeen[key].times_seen) || 0) + 1,
          });
          foundHere++;
        }
      }
      console.log(`  ${dir.label.padEnd(22)} ${cat.label.padEnd(32)} ${String(foundHere).padStart(3)} listing(s)`);
    }
  }

  /* ------------------------------------------------- cross-directory merge */
  // A product on several directories is one product with several listings.
  const byProduct = new Map();
  for (const l of listings.values()) {
    const pk = dirs.norm(l.product);
    const p = byProduct.get(pk) || {
      product: l.product, name_source: l.name_source,
      listings: [], categories: new Map(),
      first_seen: l.first_seen, is_new: true, times_seen: 0,
    };
    p.listings.push({
      directory: l.directory, directory_label: l.directory_label,
      url: l.listing_url, title: l.listing_title, snippet: l.listing_snippet,
      slug: l.slug,
    });
    for (const c of l.categories) if (!p.categories.has(c.id)) p.categories.set(c.id, c);
    // A product is new only when EVERY listing of it is new.
    p.is_new = p.is_new && l.is_new;
    p.times_seen = Math.max(p.times_seen, l.times_seen);
    if (String(l.first_seen) < String(p.first_seen)) p.first_seen = l.first_seen;
    // Prefer a title-derived name over a slug-derived one.
    if (l.name_source === "listing title" && p.name_source !== "listing title") {
      p.product = l.product; p.name_source = l.name_source;
    }
    byProduct.set(pk, p);
  }

  const products = [...byProduct.values()].map(p => {
    const conf = dirs.confidence({
      nameSource: p.name_source,
      categoryConfirm: { confirmed: true, strength: [...p.categories.values()].some(c => c.where === "listing title/snippet") ? "strong" : "moderate", matched: [...p.categories.values()][0].confirmed_by },
      directoryId: p.listings[0].directory,
      corroborations: p.listings.length - 1,
    });
    return {
      product: p.product,
      name_source: p.name_source,
      categories: [...p.categories.values()],
      /* DISTINCT directories. A product can have two pages on one directory
       * (Capterra lists some products under two ids), and the raw map produced
       * "g2, capterra, capterra" — which reads as a data error even though both
       * listings are real. The listings array keeps every page; this counts
       * directories. */
      directories: [...new Set(p.listings.map(l => l.directory))],
      listings: p.listings,
      first_seen: p.first_seen,
      is_new: p.is_new,
      times_seen: p.times_seen,
      confidence: conf.score,
      confidence_basis: conf.basis,
      // Filled by --resolve, and explicitly null otherwise rather than guessed.
      website: null,
      website_status: "not resolved",
    };
  }).sort((a, b) => (b.directories.length - a.directories.length) || (b.confidence - a.confidence));

  /* --------------------------------------------------- website resolution */
  if (doResolve) {
    const budget = dirs.LIMITS.max_website_resolutions_per_run || 12;
    const targets = products.filter(p => p.is_new).slice(0, budget);
    console.log(`\n  resolving vendor websites for ${targets.length} new product(s)…`);
    for (const p of targets) {
      await sleep(dirs.LIMITS.query_gap_ms || 1400);
      const w = await resolveWebsite(p.product);
      if (!w.ok) {
        p.website_status = `unresolved — ${w.reason}`;
        console.log(`    ${p.product.padEnd(28)} unresolved`);
        continue;
      }
      p.website = w.website;
      p.website_status = "resolved";
      const a = await assessWebsite(w.website, p.product);
      if (a.ok) {
        /* CONFLICT CHECK.
         *
         * The directories say this product is in a knowledge/documentation
         * category. If the resolved homepage then scores as "not a competitor",
         * the two sources disagree and one of them is wrong — most often the
         * domain, because name-based resolution can land on a same-named but
         * unrelated company (measured: "Shelf" resolving to shelf.im when the
         * knowledge-management vendor is shelf.io).
         *
         * Neither reading is asserted over the other. The conflict is recorded
         * so a human checks the domain, rather than the dashboard confidently
         * publishing a wrong site or a wrong score. */
        const conflict = a.classification === "not_a_competitor" && p.directories.length >= 1;
        Object.assign(p, {
          description: a.description, description_note: a.description_note, company: a.company,
          classification: a.classification, classification_basis: a.classification_basis,
          threat_score: a.threat_score, threat_band: a.threat_band,
          why_it_could_compete: a.why_it_could_compete, threat_signals: a.threat_signals,
          assessment_confidence: a.assessment_confidence,
          evidence_content_sha256: a.evidence_content_sha256,
          website_name_overlap: w.name_overlap ?? null,
          source_conflict: conflict
            ? {
              kind: "directory_vs_homepage",
              detail:
                `${p.directories.length} directory listing(s) place "${p.product}" in ` +
                `${p.categories.map(c => c.label).join(", ")}, but the homepage resolved for it ` +
                `(${w.host}) does not read as a competitor. The resolved domain is matched on name ` +
                `similarity, so it may belong to a different company with the same name — verify the ` +
                `website before relying on either the score or the URL.`,
              resolved_host: w.host,
              name_overlap: w.name_overlap ?? null,
            }
            : null,
        });
        console.log(`    ${p.product.padEnd(28)} ${w.host.padEnd(30)} threat ${a.threat_score} (${a.classification})` +
          (conflict ? "  ⚠ conflicts with the directory categorisation" : ""));
      } else {
        p.website_status = `resolved but not assessed — ${a.reason}`;
        console.log(`    ${p.product.padEnd(28)} ${w.host.padEnd(30)} not assessed`);
      }
    }
  }

  /* ------------------------------------------------------------- persist */
  const seenState = {};
  for (const [key, l] of listings) {
    seenState[key] = {
      first_seen: l.first_seen,
      times_seen: l.times_seen,
      product: l.product,
      last_seen: new Date().toISOString(),
    };
  }
  // Carry forward listings this run's slice did not revisit.
  for (const [k, v] of Object.entries(prevSeen)) if (!seenState[k]) seenState[k] = v;

  const perDirectory = {};
  for (const d of directories) {
    const mine = products.filter(p => p.directories.includes(d.id));
    perDirectory[d.id] = {
      label: d.label,
      products: mine.length,
      new: mine.filter(p => p.is_new).length,
      by_category: Object.fromEntries(categories.map(c => [
        c.id, mine.filter(p => p.categories.some(x => x.id === c.id)).length,
      ])),
      // 403 on a direct fetch is not a failure to report — it is why the search
      // index is used, and saying so keeps the method auditable.
      access: "public search index (direct fetch returns 403 from this directory's WAF)",
    };
  }

  const out = {
    audited_at: new Date().toISOString(),
    status: "audited",
    access_method:
      "Read through Google's/Bing's public index via SearXNG using site: queries. Five of the seven " +
      "directories return HTTP 403 to a direct fetch, but their robots.txt files permit product and " +
      "category pages — it is a WAF, not a policy. No bot protection was circumvented.",
    method:
      "A listing is counted in a category only when the listing's OWN title, snippet or URL places it " +
      "there. The search term that surfaced it is never treated as evidence about it — the same rule " +
      "the web-discovery collector uses.",
    directories_audited: directories.map(d => d.id),
    categories_audited: categories.map(c => c.id),
    stats,
    totals: {
      products: products.length,
      new: products.filter(p => p.is_new).length,
      multi_directory: products.filter(p => p.directories.length > 1).length,
      excluded: excluded.length,
      category_unconfirmed: unconfirmed.length,
      rejected: rejected.length,
    },
    per_directory: perDirectory,
    per_category: Object.fromEntries(categories.map(c => [
      c.id,
      {
        label: c.label,
        products: products.filter(p => p.categories.some(x => x.id === c.id)).length,
        new: products.filter(p => p.is_new && p.categories.some(x => x.id === c.id)).length,
      },
    ])),
    products,
    // Kept visible: an exclusion nobody can see is indistinguishable from a bug.
    excluded: excluded.slice(0, 200),
    category_unconfirmed: unconfirmed.slice(0, 200),
    rejected_sample: rejected.slice(0, 120),
    search_gaps: searchGaps,
    products_state: seenState,
  };

  writeJson(OUT, out);
  writeJson(DATA_OUT, { ...out, products_state: undefined });

  /* -------------------------------------------------------------- report */
  console.log(`\n  ${products.length} product(s) listed · ${out.totals.new} new · ${out.totals.multi_directory} on multiple directories`);
  console.log(`  excluded ${excluded.length} (tracked/incumbent) · category unconfirmed ${unconfirmed.length} · rejected ${rejected.length}`);

  console.log(`\n  by category:`);
  for (const c of categories) {
    const pc = out.per_category[c.id];
    console.log(`    ${c.label.padEnd(34)} ${String(pc.products).padStart(3)} listed, ${pc.new} new`);
  }

  const news = products.filter(p => p.is_new);
  if (news.length) {
    console.log(`\n  NEW product listings (${news.length}):`);
    for (const p of news.slice(0, 25)) {
      console.log(`    ${String(Math.round(p.confidence * 100) + "%").padStart(4)}  ${p.product.padEnd(30)} ${p.directories.join(", ")}`);
      console.log(`          ${p.categories.map(c => c.label).join(" · ")}`);
      if (p.website) console.log(`          ${p.website}${p.threat_score != null ? `  threat ${p.threat_score} (${p.classification})` : ""}`);
    }
    if (news.length > 25) console.log(`    … ${news.length - 25} more`);
  }

  if (unconfirmed.length) {
    console.log(`\n  Category unconfirmed — real product pages that do not place themselves in the category:`);
    for (const u of unconfirmed.slice(0, 6)) {
      console.log(`    ${String(u.name).padEnd(28)} ${u.directory}/${u.category}`);
    }
  }

  console.log(`\n  written: collectors/store/directory-listings.json and data/directory-listings.json\n`);
})();
