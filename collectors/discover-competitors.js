/**
 * New-competitor discovery.  `npm run discover` [-- --keywords=N]
 *
 * Walks the market keyword taxonomy (config/keywords.json), finds product
 * websites that are NOT already tracked and NOT established incumbents, and
 * records each with its real homepage, a two-line description taken from the
 * page's own metadata, and the keywords that surfaced it.
 *
 * WHAT MAKES THIS TRUSTWORTHY RATHER THAN A LIST OF GUESSES
 * --------------------------------------------------------
 * 1. Every entrant is a page we FETCHED. Name, description and website all come
 *    from that page's own og:/meta tags — never from a model and never inferred
 *    from a search snippet.
 * 2. A candidate must look like a PRODUCT SITE, not an article about products.
 *    Listicles ("Top 10 documentation tools") are the dominant result for these
 *    keywords, and treating them as entrants would fill the section with blog
 *    posts. Two positive product signals are required, and listicle signals
 *    disqualify.
 *    Corollary: this section will be SMALLER than the raw search volume suggests.
 *    That is the intended trade — a short accurate list beats a long noisy one.
 * 3. The 7 tracked products and 92 known incumbents are excluded by domain and
 *    by name, so the section shows only what is actually new to us.
 * 4. A ROTATING CURSOR is persisted. 233 keywords is far more than the
 *    rate-limited backend serves in one run, so each run advances through the
 *    list and coverage accumulates. Priority-3 categories are visited most often
 *    because they surface named products most reliably.
 * 5. Confidence is recorded per entrant: how many distinct keywords surfaced it,
 *    and whether its own page confirms it is in this category.
 */
const path = require("path");
const fs = require("fs");
const { fetchUrl, pool } = require("./lib/fetch");
const { htmlToText, extractTitle, domainOf, canonicalUrl } = require("./lib/verify");
const { brandOrder, brand } = require("./lib/brands");
const threat = require("./lib/threat");
const { readJson, writeJson, STORE_DIR } = require("./lib/store");

const KEYWORDS = require("../config/keywords.json");
const CURSOR = path.join(STORE_DIR, "discover-cursor.json");
const OUT = path.join(STORE_DIR, "competitors.json");

const RESULTS_PER_QUERY = 12;
const QUERY_GAP_MS = 1200;

/**
 * Modifiers appended in --recent mode. The daily monitor is looking for what is
 * NEW, and a bare category query returns the same established pages every day;
 * these terms are what actually surface an arrival.
 */
const RECENCY_MODIFIERS = ["launch 2026", "new AI", "beta", "raised funding", "launched"];
let RECENT_MODE = false;

/* ---------------------------------------------------------------- exclusions */

/** Domains and names that are not new entrants. */
function buildExclusions() {
  const names = new Set(KEYWORDS.exclude_incumbents.map(s => s.toLowerCase()));
  const domains = new Set(KEYWORDS.exclude_incumbents.map(s => s.toLowerCase() + ".com"));
  for (const id of brandOrder()) {
    const b = brand(id);
    names.add(b.name.toLowerCase());
    b.aliases.forEach(a => names.add(a.toLowerCase().replace(/\s+/g, "")));
    if (b.domain) domains.add(b.domain.toLowerCase());
  }
  // Hosts that are never a product's own site.
  const hostBlock = [
    /(^|\.)(google|bing|duckduckgo|yahoo|yandex|baidu)\./,
    /(^|\.)(youtube|youtu\.be|vimeo)\./,
    /(^|\.)(reddit|quora|stackoverflow|stackexchange)\./,
    /(^|\.)(medium|substack|dev\.to|hashnode)\./,
    /(^|\.)(linkedin|twitter|x\.com|facebook|instagram|tiktok|threads)\./,
    /(^|\.)(g2|capterra|trustradius|getapp|softwareadvice|sourceforge|slashdot)\./,
    // Software directories and review aggregators rank for every one of these
    // keywords and are never themselves an entrant. Measured: SoftwareSuggest
    // was admitted on the first run purely because it ranks for "best
    // documentation software".
    /(^|\.)(softwaresuggest|saasworthy|financesonline|trustpilot|goodfirms|softwarereviews|selecthub|technologyadvice|softwarepundit|crozdesk|tekpon|alternativeto|slant|stackshare|comparecamp)\./,
    /(^|\.)(github|gitlab|bitbucket|npmjs|pypi|crates\.io)\./,
    /(^|\.)(producthunt|crunchbase|techcrunch|venturebeat|forbes|businessinsider)\./,
    /(^|\.)(wikipedia|wikimedia|archive\.org)\./,
    /(^|\.)(amazon|apple|microsoft|adobe|salesforce|oracle|ibm|sap)\./,
    /\.(gov|edu|mil)$/,
  ];
  return { names, domains, hostBlock };
}

/**
 * A documentation SITE is not a documentation PRODUCT.
 *
 * Measured: `docs.x.ai` was admitted as an entrant because its title reads
 * "Grok API Documentation" — it satisfies every category term while being
 * xAI's own hosted docs rather than a platform anyone could buy. The same
 * applies to help.*, support.*, developer.* and every other docs subdomain on
 * the web, which is a very large false-positive class.
 *
 * The distinction is structural rather than textual, so it belongs here at the
 * host gate instead of in the page-content checks.
 */
const DOCS_SUBDOMAIN = /^(docs?|help|support|developer|developers|dev|api|kb|knowledge|guide|guides|learn|manual|wiki|handbook|reference)\./i;

function isExcluded(host, ex) {
  const h = host.toLowerCase();
  if (ex.domains.has(h)) return "already tracked or a known incumbent";
  if (ex.hostBlock.some(re => re.test(h))) return "not a product's own website";

  if (DOCS_SUBDOMAIN.test(h)) {
    return "a company's own documentation site, not a documentation product";
  }

  const root = h.replace(/^www\./, "").split(".")[0];
  if (ex.names.has(root)) return `known incumbent (${root})`;

  /* Incumbents register variant domains that a whole-label match misses.
   * Measured: ProProfs was admitted because its domain is `proprofskb.com`, so
   * the root label `proprofskb` did not equal `proprofs`. Check whether the root
   * STARTS WITH a known incumbent name, which catches proprofskb, notionhq,
   * atlassianlabs and similar without matching unrelated short words. */
  for (const name of ex.names) {
    if (name.length >= 5 && root.startsWith(name)) return `known incumbent variant domain (${name})`;
  }
  return null;
}

/* ------------------------------------------------------- product-page test */

/**
 * Does this page look like a product's own site rather than an article about
 * products? Requires >=2 positive signals and no listicle signal.
 */
function productPageScore(html, text) {
  const lower = text.toLowerCase().slice(0, 6000);
  const sig = KEYWORDS.product_page_signals;
  const positives = sig.positive.filter(s => lower.includes(s));
  const negatives = sig.negative.filter(s => lower.includes(s));

  // A heading that enumerates ("7 best…") is an article, not a product.
  const listicleTitle = /^\s*(?:top|best)\s+\d+|^\s*\d+\s+(?:best|top|great)\b/i.test(
    extractTitle(html) || ""
  );
  // Product sites almost always expose OpenGraph type website/product.
  const ogType = (String(html).match(/<meta[^>]+property=["']og:type["'][^>]+content=["']([^"']+)["']/i) || [])[1];
  const isArticle = /article|blog/i.test(ogType || "");

  return {
    positives,
    negatives,
    listicleTitle,
    ogType: ogType || null,
    isProduct: positives.length >= 2 && negatives.length === 0 && !listicleTitle && !isArticle,
  };
}

/**
 * The product's own two-line description, taken from its metadata in order of
 * reliability. Never composed by us.
 */
function extractDescription(html) {
  const pats = [
    [/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{20,400})["']/i, "og:description"],
    [/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{20,400})["']/i, "meta:description"],
    [/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']{20,400})["']/i, "twitter:description"],
  ];
  // A description is skipped when it is an unrendered template or cookie
  // boilerplate rather than prose. Measured: liveagent.com's own meta
  // description is `${e.title} ${t?` ${s}. `:""} ${e.title} . ${n}.` — real
  // page content, but it tells a reader nothing and rendering it looks like
  // OUR template broke.
  const { isUsableDescription } = require("./lib/verify");
  let skipped = null;

  for (const [re, method] of pats) {
    const m = String(html).match(re);
    if (m) {
      const d = m[1].replace(/\s+/g, " ").trim();
      const u = isUsableDescription(d);
      if (u.ok) return { description: d, method };
      if (!skipped) skipped = u.reason;
    }
  }
  // Fall back to the first substantial sentence of the page's own text.
  const t = htmlToText(html);
  const sentence = t.split(/(?<=[.!?])\s+/).find(s =>
    s.length > 40 && s.length < 320 && isUsableDescription(s).ok);
  return sentence
    ? { description: sentence.trim(), method: "first sentence of page text" }
    : { description: null, method: skipped ? `skipped — ${skipped}` : null };
}

/** The product's own name, from its metadata rather than the search result. */
function extractName(html, host) {
  const og = (String(html).match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) || [])[1];
  if (og && og.length < 40) return { name: og.trim(), method: "og:site_name" };

  const title = extractTitle(html) || "";
  // Titles are usually "Name — tagline" or "Name | tagline".
  const head = title.split(/\s*[|—–·:]\s*/)[0].trim();
  if (head && head.length >= 2 && head.length < 40) return { name: head, method: "page title" };

  const root = host.replace(/^www\./, "").split(".")[0];
  return { name: root.charAt(0).toUpperCase() + root.slice(1), method: "domain name" };
}

/* ------------------------------------------------------ keyword rotation */

function flatKeywords() {
  const out = [];
  for (const c of KEYWORDS.categories) {
    for (const k of c.keywords) {
      out.push({ keyword: k, category: c.id, category_label: c.label, priority: c.priority });
    }
  }
  // Priority-3 first so a short run still covers the highest-yield terms, then
  // by priority within a stable order so the cursor walks predictably.
  return out.sort((a, b) => b.priority - a.priority);
}

function nextBatch(size) {
  const all = flatKeywords();
  const cur = readJson(CURSOR, { index: 0, sweeps: 0, runs: 0 });
  const batch = [];
  for (let i = 0; i < size; i++) {
    batch.push(all[(cur.index + i) % all.length]);
  }
  const nextIndex = (cur.index + size) % all.length;
  const wrapped = cur.index + size >= all.length;
  return { batch, nextIndex, wrapped, total: all.length, cursor: cur };
}

/* ---------------------------------------------------------------- discovery */

(async () => {
  const arg = (k, d) => {
    const a = process.argv.find(x => x.startsWith(`--${k}=`));
    return a ? a.split("=")[1] : d;
  };
  const batchSize = Math.max(1, parseInt(arg("keywords", "24"), 10));
  // --recent biases the sweep toward launches, funding and betas, which is what
  // the daily monitor wants. Without it the sweep is category-wide.
  RECENT_MODE = process.argv.includes("--recent");

  const provider = await require("./lib/serp-provider").resolve({ log: m => console.log(m) });
  if (provider.unavailable) {
    console.error(`\n  No search provider available: ${provider.note}\n`);
    process.exit(1);
  }

  const { batch, nextIndex, wrapped, total, cursor } = nextBatch(batchSize);
  const ex = buildExclusions();

  console.log(`\nNew-competitor discovery`);
  console.log(`  keyword taxonomy: ${total} terms across ${KEYWORDS.categories.length} categories`);
  console.log(`  this run: ${batch.length} keywords from cursor ${cursor.index}${wrapped ? " (wraps)" : ""}`);
  console.log(`  provider: ${provider.label}\n`);

  // --- 1. search each keyword, collect candidate domains ---
  const candidates = new Map();   // host -> { url, keywords:Set, titles:[] }
  const searchGaps = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  for (const kw of batch) {
    await sleep(QUERY_GAP_MS);
    // In --recent mode each keyword is rotated through a launch-oriented
    // modifier, so a daily run does not re-issue yesterday's exact query.
    const query = RECENT_MODE
      ? `${kw.keyword} ${RECENCY_MODIFIERS[(cursor.runs || 0) % RECENCY_MODIFIERS.length]}`
      : kw.keyword;
    const s = await provider.search(query, { days: RECENT_MODE ? 30 : 365 });
    if (!s.ok) {
      searchGaps.push({ keyword: query, error: s.error });
      continue;
    }
    let kept = 0;
    for (const r of (s.results || []).slice(0, RESULTS_PER_QUERY)) {
      if (!r.url) continue;
      const host = domainOf(r.url);
      if (!host) continue;
      const why = isExcluded(host, ex);
      if (why) continue;

      if (!candidates.has(host)) {
        // Probe the site ROOT, not the deep result URL: a product's identity
        // lives on its homepage, and a deep page is usually a blog post.
        candidates.set(host, {
          host,
          probe_url: `https://${host}/`,
          found_url: r.url,
          keywords: new Set(),
          categories: new Set(),
          snippets: [],
        });
      }
      const c = candidates.get(host);
      c.keywords.add(kw.keyword);
      c.categories.add(kw.category_label);
      if (r.title) c.snippets.push(r.title);
      kept++;
    }
    console.log(`    ${String(kept).padStart(2)} candidate host(s)  ${kw.keyword}`);
  }

  console.log(`\n  ${candidates.size} distinct candidate domain(s) to verify`);

  // --- 2. fetch each candidate's homepage and decide ---
  const list = [...candidates.values()];
  const verified = [];
  const rejected = [];

  await pool(list, 8, async c => {
    const r = await fetchUrl(c.probe_url, { retries: 1, timeout: 20000 });
    if (!r.ok) {
      rejected.push({ host: c.host, reason: `homepage returned HTTP ${r.status || "no response"}` });
      return;
    }
    const text = htmlToText(r.body);
    const score = productPageScore(r.body, text);
    if (!score.isProduct) {
      rejected.push({
        host: c.host,
        reason: score.listicleTitle
          ? "listicle/article, not a product site"
          : score.negatives.length
            ? `article signals present: ${score.negatives.join(", ")}`
            : `only ${score.positives.length} product signal(s); needs 2`,
      });
      return;
    }

    const { name, method: nameMethod } = extractName(r.body, c.host);
    const { description, method: descMethod } = extractDescription(r.body);

    // Re-check the name against exclusions: the domain may be new to us while the
    // product is a known incumbent under a different domain.
    if (ex.names.has(name.toLowerCase().replace(/\s+/g, ""))) {
      rejected.push({ host: c.host, reason: `resolves to known incumbent "${name}"` });
      return;
    }

    /* CATEGORY CONFIRMATION — tightened, because the loose version admitted
     * products that merely rank for these keywords:
     *   Documenso   e-signature ("Sign everywhere with Documenso")
     *   Bullet AI   Notion→website builder
     *   Produkt.so  adjacent, but a help-centre theme rather than a docs platform
     *
     * The category term must appear in what the product says it IS — its title or
     * meta description — not merely somewhere in 8KB of page text, where a footer
     * link or a customer logo is enough to trigger a match.
     *
     * A negative list rejects neighbouring categories that legitimately use the
     * word "document" while not competing with us at all. */
    const CATEGORY_TERMS = /\b(documentation|knowledge base|knowledge-base|help ?cent(?:er|re)|technical writing|API (?:docs|reference)|developer portal|knowledge management|docs platform|product docs|SOP)\b/i;
    const WRONG_CATEGORY = /\b(e-?sign\w*|signature|contract|invoic\w*|payroll|CRM|website builder|page builder|form builder|survey|e-?commerce|accounting|HR platform|applicant|recruit\w*|password manager|VPN|antivirus)\b/i;

    const identity = [
      extractTitle(r.body) || "",
      (String(r.body).match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i) || [])[1] || "",
    ].join(". ");

    const categoryConfirmed = CATEGORY_TERMS.test(identity);
    const wrongCategory = WRONG_CATEGORY.test(identity) && !categoryConfirmed;

    if (wrongCategory) {
      rejected.push({
        host: c.host,
        reason: `adjacent but different category — its own description says: "${identity.slice(0, 90)}"`,
      });
      return;
    }
    if (!categoryConfirmed) {
      rejected.push({
        host: c.host,
        reason: `own title/description does not place it in this category: "${identity.slice(0, 90)}"`,
      });
      return;
    }

    /* COMPETITIVE ASSESSMENT — scored from the product's own words only.
     * The keyword that surfaced the site is deliberately NOT passed in: the
     * requirement is that classification requires evidence, not keywords. */
    const assessment = threat.assess({ identity, body_text: text });
    const company = threat.extractCompany(r.body, name);
    const launch = threat.extractLaunchDate(r.body, text);

    verified.push({
      name,
      name_source: nameMethod,
      company: company.company,
      company_source: company.method,
      company_same_as_product: company.same_as_product,
      website: `https://${c.host}/`,
      domain: c.host,
      description,
      description_source: descMethod,
      // Confidence is explicit about what supports it.
      confidence:
        (categoryConfirmed ? 0.5 : 0.2) +
        Math.min(0.3, c.keywords.size * 0.1) +
        Math.min(0.2, score.positives.length * 0.05),
      category_confirmed: categoryConfirmed,
      surfaced_by_keywords: [...c.keywords],
      categories: [...c.categories],
      product_signals: score.positives,
      og_type: score.ogType,
      http_status: r.status,

      // Two different dates, never conflated: when the product says it launched
      // (often unknown), and when this collector first saw it.
      launch_date: launch ? launch.date : null,
      launch_date_precision: launch ? launch.precision : null,
      launch_date_basis: launch ? `${launch.method}: "${launch.basis}"` : null,
      first_seen: new Date().toISOString(),
      verified_at: new Date().toISOString(),

      classification: assessment.classification,
      classification_basis: assessment.classification_basis,
      threat_score: assessment.threat_score,
      threat_band: assessment.threat_band,
      why_it_could_compete: assessment.why_it_could_compete,
      threat_signals: assessment.signals,
      assessment_confidence: assessment.assessment_confidence,
      assessment_method: assessment.method,

      evidence_excerpt: text.slice(0, 300).trim(),
      // The page this judgement was made from, plus the search result that led
      // here — both needed to re-check any claim above.
      evidence_url: `https://${c.host}/`,
      evidence_content_sha256: r.content_sha256,
      found_via_url: c.found_url,
    });
  });

  // --- 3. merge with anything already known, preserving first_seen ---
  const prev = readJson(OUT, { competitors: [] });
  const prevByDomain = new Map((prev.competitors || []).map(c => [c.domain, c]));
  const merged = [];
  for (const v of verified) {
    const old = prevByDomain.get(v.domain);
    if (old) {
      merged.push({
        ...v,
        first_seen: old.first_seen || v.first_seen,   // never lose the original sighting
        times_seen: (old.times_seen || 1) + 1,
        surfaced_by_keywords: [...new Set([...(old.surfaced_by_keywords || []), ...v.surfaced_by_keywords])],
        categories: [...new Set([...(old.categories || []), ...v.categories])],
      });
      prevByDomain.delete(v.domain);
    } else {
      merged.push({ ...v, times_seen: 1 });
    }
  }
  // Keep previously-found entrants that this run's keyword slice did not revisit.
  for (const old of prevByDomain.values()) merged.push(old);

  // Threat first, then confidence. A board reads this list top-down, so the
  // ordering has to answer "what should worry me" rather than "what are we most
  // certain exists".
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

  const newDomains = verified
    .filter(v => !(prev.competitors || []).some(p => p.domain === v.domain))
    .map(v => v.domain);

  writeJson(OUT, {
    scanned_at: new Date().toISOString(),
    status: "scanned",
    provider: provider.label,
    keywords_total: total,
    keywords_this_run: batch.map(b => b.keyword),
    recent_mode: RECENT_MODE,
    cursor_index: nextIndex,
    sweeps_completed: (cursor.sweeps || 0) + (wrapped ? 1 : 0),
    runs: (cursor.runs || 0) + 1,
    candidates_examined: candidates.size,
    verified_count: merged.length,
    new_this_run: newDomains.length,
    new_domains_this_run: newDomains,
    by_classification: byClass,
    high_threat_count: merged.filter(m => (m.threat_score || 0) >= 70).length,
    rejected_this_run: rejected,
    search_gaps: searchGaps,
    method:
      "Keyword-driven web discovery. Every entrant is a fetched homepage; name and " +
      "description come from that page's own metadata. Listicles and articles are " +
      "excluded, as are the 7 tracked products and 92 known incumbents. " +
      "Classification and threat score are derived ONLY from what each product " +
      "publishes about itself — never from the keyword that surfaced it — and every " +
      "signal records the phrase it matched.",
    competitors: merged,
  });

  writeJson(CURSOR, {
    index: nextIndex,
    sweeps: (cursor.sweeps || 0) + (wrapped ? 1 : 0),
    runs: (cursor.runs || 0) + 1,
    last_run_at: new Date().toISOString(),
    next_keywords: flatKeywords().slice(nextIndex, nextIndex + 5).map(k => k.keyword),
  });

  console.log(`\n  verified entrants: ${verified.length} this run · ${merged.length} known in total`);
  console.log(`  rejected: ${rejected.length}`);
  const byReason = {};
  for (const r of rejected) {
    const k = r.reason.replace(/\d+/g, "N").slice(0, 60);
    byReason[k] = (byReason[k] || 0) + 1;
  }
  for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`      ${String(v).padStart(3)}  ${k}`);
  }
  if (verified.length) {
    console.log(`\n  found this run:`);
    for (const v of verified.slice(0, 12)) {
      console.log(`    ${v.name.padEnd(22)} ${v.website}`);
      console.log(`      ${String(v.description || "(no description on page)").slice(0, 100)}`);
    }
  }
  console.log(`\n  cursor now at ${nextIndex}/${total}; next: ${flatKeywords()[nextIndex].keyword}`);
  console.log(`  written to store/competitors.json\n`);
})();
