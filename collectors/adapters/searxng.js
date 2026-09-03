/**
 * Adapter: SearXNG  →  channels "web", "linkedin", "x", "video", "blog", "event"
 * Repo: https://github.com/searxng/searxng
 *
 * SearXNG is a self-hosted metasearch front-end over Google, Bing, DuckDuckGo,
 * Brave, Startpage and others. It is the substitute for a paid SERP API here:
 * no key, no per-query cost, and it is also how LinkedIn and X coverage happens
 * WITHOUT platform credentials — public posts are reachable through `site:`
 * queries against the underlying engines.
 *
 * Requires a running instance. Set SEARXNG_URL (default http://localhost:8888).
 * `docker compose -f collectors/searxng/docker-compose.yml up -d` starts one with
 * JSON output already enabled — SearXNG disables format=json by default, so the
 * shipped settings.yml adds it under `search.formats`.
 *
 * If no instance is reachable this adapter reports unavailable and contributes
 * nothing. It never estimates.
 */
const provider = require("../lib/serp-provider");
const client = require("../lib/searxng-client");
const { allBrands, searchTerms, eventConfig } = require("../lib/brands");
const { domainOf } = require("../lib/verify");

const BASE = client.BASE;

/** SearXNG time_range accepts day | month | year (no "week"). */
function timeRange(days) {
  if (days <= 1) return "day";
  if (days <= 31) return "month";
  return "year";
}

async function search(query, opts) {
  const p = await provider.resolve();
  return p.search(query, opts);
}

/** Probe via the provider so a SearXNG outage degrades instead of zeroing. */
async function probe() {
  const p = await provider.resolve();
  return p.unavailable ? { ok: false, reason: p.note } : { ok: true, reason: null, detail: p.note, provider: p.id, degraded: p.degraded };
}

/**
 * Per-channel query plans. Each plan says which channel its hits belong to and
 * how to constrain the search so results are actually that channel.
 */
/**
 * Query plans, with PAGINATION and multiple angles per channel.
 *
 * The previous version ran exactly ONE query per channel per brand, page 1 only.
 * SearXNG returns ~20 results per page, so the hard ceiling was ~20 candidates per
 * channel per brand — before dedupe and the content-page gate. That is why the
 * dashboard showed 29 LinkedIn records for Document360 in total: not a display
 * problem, a collection-depth problem.
 *
 * Measured: pages 2-5 each return a further 20 distinct results, so paginating is
 * a 5x multiplier at the cost of 4 extra queries. Multiple query angles then widen
 * recall further, because each phrasing surfaces a different slice of the index.
 *
 * PAGES is deliberately higher for the channels the board cares about (LinkedIn,
 * web, X) and lower for ones with a first-party feed already covering them.
 */
/**
 * Page budgets, cut back deliberately.
 *
 * Pagination was sized when ONE engine answered and returned 20 results a page.
 * With 13 engines enabled, a single page-1 query now returns ~54 results, so deep
 * pagination stopped buying recall and started buying a verification backlog:
 * 67 queries x ~54 results was ~3,600 raw candidates per brand, and verifying
 * those at concurrency 5 took longer than an hour per brand — which is why the
 * sweep sat on Document360 for 40 minutes and persisted nothing.
 *
 * Fewer pages across more engines gets the same coverage in a fraction of the time.
 */
const PAGES = { linkedin: 2, x: 2, youtube: 1, instagram: 1, facebook: 1, web: 2, blog: 1, event: 1 };

/** Per-query result cap. More than this per query is duplicate-heavy noise. */
const RESULTS_PER_QUERY = 20;

function plansFor(brand, days) {
  const term = searchTerms(brand.id)[0]; // exact-phrase primary alias
  const bare = term.replace(/"/g, "");
  const base = [];

  // --- LinkedIn: several angles, because one phrasing badly under-samples ---
  base.push(
    { channel: "linkedin", q: `${term} site:linkedin.com`, note: "LinkedIn — brand mention" },
    { channel: "linkedin", q: `${term} site:linkedin.com/posts`, note: "LinkedIn — posts" },
    { channel: "linkedin", q: `${term} site:linkedin.com/pulse`, note: "LinkedIn — articles" },
    { channel: "linkedin", q: `${term} knowledge base site:linkedin.com`, note: "LinkedIn — category context" },
    { channel: "linkedin", q: `${term} documentation site:linkedin.com`, note: "LinkedIn — docs context" }
  );

  // --- X ---
  // Deliberately NO parenthesised OR. Measured: of the 5 engines that honour
  // `site:` (yandex, naver, privacywall, seznam, yahoo), none reliably parse
  // `(site:a OR site:b)` — they return 0 for it, which made X collection depend
  // entirely on `google cse` and therefore die whenever that engine suspended.
  // One simple query per domain instead.
  base.push(
    { channel: "x", q: `${term} site:x.com`, note: "X — brand mention (x.com)" },
    { channel: "x", q: `${term} site:twitter.com`, note: "X — brand mention (twitter.com)" },
    { channel: "x", q: `${bare} docs site:x.com`, note: "X — docs context" }
  );

  // --- Web: the widest channel, so the most angles ---
  base.push(
    { channel: "web", q: `${term} review`, note: "web — reviews" },
    { channel: "web", q: `${term} alternatives`, note: "web — alternatives/comparisons" },
    { channel: "web", q: `${term} vs`, note: "web — head-to-head" },
    { channel: "web", q: `${term} pricing`, note: "web — pricing coverage" },
    { channel: "web", q: `${term} case study`, note: "web — customer stories" },
    { channel: "web", q: `${term} "knowledge base software"`, note: "web — category listicles" }
  );

  // --- YouTube ---
  base.push(
    { channel: "youtube", q: `${term} site:youtube.com`, note: "YouTube — brand mention" },
    { channel: "youtube", q: `${term} review site:youtube.com`, note: "YouTube — reviews/demos" }
  );

  // --- Instagram + Facebook ---
  // Both are heavily login-walled, so search-engine coverage is thin by nature.
  // Included because the brief asks for them; the dashboard labels the resulting
  // counts as a floor rather than implying full coverage.
  base.push(
    { channel: "instagram", q: `${term} site:instagram.com`, note: "Instagram — posts" },
    { channel: "facebook", q: `${term} site:facebook.com`, note: "Facebook — posts" }
  );

  // --- Blog: always run, not just for brands lacking a feed. A first-party feed
  //     covers only the brand's OWN blog, not third-party blogs writing about it.
  base.push(
    { channel: "blog", q: `${term} blog`, note: "blog — third-party posts" },
    { channel: "blog", q: `${term} guide`, note: "blog — how-to coverage" }
  );

  // --- Events ---
  for (const tpl of eventConfig().search_templates) {
    base.push({
      channel: "event",
      q: tpl.replace(/\{brand\}/g, brand.name),
      note: "event sponsorship",
      requireSponsorTerm: true,
    });
  }

  // Expand each plan across its channel's page budget.
  const plans = [];
  for (const p of base) {
    const pages = PAGES[p.channel] || 1;
    for (let pg = 1; pg <= pages; pg++) {
      plans.push({ ...p, pageno: pg, note: `${p.note} p${pg}` });
    }
  }
  return plans;
}

module.exports = {
  id: "searxng",
  label: "SearXNG metasearch (self-hosted)",
  channel: "multi",
  requires: ["a running SearXNG instance (SEARXNG_URL)"],
  probe,
  available() {
    // Cheap synchronous answer; runner calls probe() for the real check.
    return { ok: true, reason: null };
  },

  async collect({ sinceDays = 90, brands = null, log = () => {} } = {}) {
    const candidates = [];
    const gaps = [];

    const p = await probe();
    if (!p.ok) {
      gaps.push({ brand_id: null, reason: p.reason });
      log(`    unavailable: ${p.reason}`);
      return { candidates, gaps, unavailable: true };
    }

    const sponsorTerms = eventConfig().sponsor_terms.map(t => t.toLowerCase());
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // Upstream engines rate-limit. Measured: `google cse` returns
    // "Suspended: too many requests" after roughly 40 queries, with
    // suspended_time=180 in SearXNG's log. A full run is ~63 queries (7 brands x
    // ~9 plans), so a naive loop exhausts the engine a third of the way in — which
    // is exactly what happened: Document360/Mintlify/GitBook populated and the
    // remaining four brands silently returned nothing.
    //
    // So: pace queries, and when every engine is suspended, wait out the
    // suspension and retry once rather than recording a false zero.
    const QUERY_GAP_MS = 1500;
    const SUSPENSION_WAIT_MS = 185000; // slightly over SearXNG's 180s suspended_time
    let suspensionWaits = 0;
    const MAX_SUSPENSION_WAITS = 2; // 2 x 185s keeps a single-brand run inside ~7min

    /** Run one query, surviving a transient engine suspension. */
    async function runQuery(q, pageno) {
      let s = await search(q, { days: sinceDays, pageno });
      const suspended = r =>
        r.ok && (r.results || []).length === 0 && (r.unresponsive_engines || []).length > 0;

      if (suspended(s) && suspensionWaits < MAX_SUSPENSION_WAITS) {
        const why = (s.unresponsive_engines || [])
          .map(e => (Array.isArray(e) ? e.join(": ") : String(e)))
          .join(", ");
        suspensionWaits++;
        log(`      all engines suspended (${why}) — waiting ${Math.round(SUSPENSION_WAIT_MS / 1000)}s (${suspensionWaits}/${MAX_SUSPENSION_WAITS})`);
        await sleep(SUSPENSION_WAIT_MS);
        s = await search(q, { days: sinceDays, pageno });
      }
      return s;
    }

    // Honour a brand filter here rather than discarding results afterwards:
    // every query costs rate-limit budget, and google cse suspends after ~40.
    const targets = brands ? allBrands().filter(b => brands.includes(b.id)) : allBrands();
    for (const b of targets) {
      let brandHits = 0;
      let brandBlocked = 0;
      for (const plan of plansFor(b, sinceDays)) {
        await sleep(QUERY_GAP_MS);
        const s = await runQuery(plan.q, plan.pageno || 1);
        if (!s.ok) {
          gaps.push({ brand_id: b.id, reason: `SearXNG query failed (${plan.note}): ${s.error}` });
          continue;
        }
        // A zero-result response while engines are suspended is NOT evidence the
        // brand is absent from that channel. Record it as a gap so the dashboard
        // shows "not measured" rather than a confident 0.
        if ((s.results || []).length === 0 && (s.unresponsive_engines || []).length > 0) {
          brandBlocked++;
          gaps.push({
            brand_id: b.id,
            reason:
              `${plan.note}: no results because every upstream engine was rate-limited ` +
              `(${(s.unresponsive_engines || []).map(e => (Array.isArray(e) ? e.join(": ") : e)).join(", ")}). ` +
              `This is a MEASUREMENT FAILURE, not an absence of mentions — the ${plan.channel} ` +
              `channel is under-reported for ${b.name}. Re-run after the suspension clears.`,
          });
          continue;
        }
        for (const res of s.results.slice(0, RESULTS_PER_QUERY)) {
          if (!res.url) continue;

          // Event hits must show a sponsorship term in the snippet or title,
          // otherwise "Guru attended" would be recorded as "Guru sponsored".
          if (plan.requireSponsorTerm) {
            const blob = `${res.title || ""} ${res.content || ""}`.toLowerCase();
            if (!sponsorTerms.some(t => blob.includes(t))) continue;
          }

          // Keep channel assignment honest: a linkedin plan hit that isn't on
          // linkedin.com is a web mention, not a LinkedIn mention.
          const dom = domainOf(res.url) || "";
          let channel = plan.channel;
          if (plan.channel === "linkedin" && !/linkedin\.com$/.test(dom)) channel = "web";
          if (plan.channel === "x" && !/(^|\.)(x|twitter)\.com$/.test(dom)) channel = "web";
          if (plan.channel === "video" && !/(youtube\.com|youtu\.be)$/.test(dom)) channel = "web";

          candidates.push({
            brand_id: b.id,
            channel,
            url: res.url,
            title: res.title || null,
            // SearXNG publishedDate is engine-reported and often absent; only
            // trust it when it parses, otherwise let the page prove its date.
            published_at: res.publishedDate ? (require("../lib/verify").toIsoDate(res.publishedDate) || null) : null,
            date_method: res.publishedDate ? "searxng:publishedDate" : null,
            source_text: res.content || null,
            source_verified: false,
            source_adapter: "searxng",
            discovered_via: s.url,
            extra: {
              searxng_engine: res.engine || null,
              query_intent: plan.note,
              query: plan.q,
            },
          });
          brandHits++;
        }
      }
      log(
        `    ${b.name}: ${brandHits} SearXNG candidates` +
          (brandBlocked ? `  (${brandBlocked} quer${brandBlocked === 1 ? "y" : "ies"} blocked by rate limiting)` : "")
      );
    }

    if (suspensionWaits >= MAX_SUSPENSION_WAITS) {
      gaps.push({
        brand_id: null,
        reason:
          `Hit the engine-suspension retry cap (${MAX_SUSPENSION_WAITS}). Later brands in the run are ` +
          `under-collected. Re-run \`npm run collect\` later, or add more engines in ` +
          `collectors/searxng/settings-local.yml so load is spread across them.`,
      });
    }

    return { candidates, gaps };
  },

  // exported for reuse by the AI-visibility SERP measurement
  _search: search,
  _base: BASE,
  _provider: provider,
};
