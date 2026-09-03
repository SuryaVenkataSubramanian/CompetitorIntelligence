/**
 * AI Visibility — custom buyer-prompt probe across six AI surfaces.
 *
 * WHAT CHANGED, AND WHY IT MATTERS
 * -------------------------------
 * This used to be able to measure exactly one surface. ChatGPT, Claude, Gemini
 * and Google AI Overview all reported "not checked", because there was no key
 * for any of them and the Bright Data account had no zone. That was honest, but
 * it was not an answer.
 *
 * DataForSEO's AI Optimization API closes the gap. Every surface below is now
 * measured from a REAL answer with REAL citations:
 *
 *   chatgpt             POST /v3/ai_optimization/chat_gpt/llm_responses/live
 *   claude              POST /v3/ai_optimization/claude/llm_responses/live
 *   gemini              POST /v3/ai_optimization/gemini/llm_responses/live
 *   perplexity          POST /v3/ai_optimization/perplexity/llm_responses/live
 *   google_ai_overview  POST /v3/serp/google/ai_mode/live/advanced
 *   google_web          POST /v3/serp/google/organic/live/advanced, or SearXNG
 *
 * HOW A RANK IS ESTABLISHED — and why it is not a guess
 * ----------------------------------------------------
 * An LLM answer is prose, not a ranked list, so "position" has to be derived.
 * It is derived MECHANICALLY: the position of a brand's first confirmed textual
 * occurrence within the answer, relative to the other brands named. That is a
 * real, reproducible ordering over the actual answer text, and the excerpt the
 * judgement came from is stored beside it so any rank can be checked by reading.
 *
 * No brand is ever recorded as present without `matchBrand` confirming it in the
 * answer text — the same disambiguation gate every mention passes, so "a
 * confluence of factors" cannot become a Confluence sighting.
 *
 * THREE STATES, NEVER CONFLATED
 * -----------------------------
 *   measured    + visible:false → we asked, the brand was absent. A finding.
 *   not_checked                 → we did not ask (no budget, no credential).
 *   failed                      → we asked and the call errored.
 *
 * The second and third are never rendered as absence. A board reading
 * "0% visible in ChatGPT" would act on a claim this system never made.
 */
const { brandOrder, brand, matchBrand, allBrands } = require("./brands");
const dfs = require("./dataforseo");
const windsor = require("./windsor");

/**
 * The six surfaces, in display order.
 *
 * `deeplink` is retained so a reader can open the same query themselves, but it
 * is no longer the primary action — the answer is now shown inline, which is
 * what the link previously stood in for.
 */
const PROVIDERS = {
  chatgpt: {
    id: "chatgpt", label: "ChatGPT", vendor: "OpenAI", kind: "llm",
    deeplink: p => "https://chatgpt.com/?q=" + encodeURIComponent(p),
    deeplink_prefills: true,
    deeplink_basis: "chatgpt.com honours ?q= — the parameter OpenAI's own search entry points use.",
  },
  claude: {
    id: "claude", label: "Claude", vendor: "Anthropic", kind: "llm",
    deeplink: p => "https://claude.ai/new?q=" + encodeURIComponent(p),
    deeplink_prefills: true,
    deeplink_basis: "claude.ai/new honours ?q= and prefills the composer.",
  },
  gemini: {
    id: "gemini", label: "Gemini", vendor: "Google", kind: "llm",
    // Gemini publishes no prompt parameter, so no fabricated one is used.
    deeplink: () => "https://gemini.google.com/app",
    deeplink_prefills: false,
    deeplink_basis: "Gemini publishes no prompt URL parameter, so the app URL is used rather than a fabricated one.",
  },
  perplexity: {
    id: "perplexity", label: "Perplexity", vendor: "Perplexity AI", kind: "llm",
    deeplink: p => "https://www.perplexity.ai/search?q=" + encodeURIComponent(p),
    deeplink_prefills: true,
    deeplink_basis: "perplexity.ai/search?q= is Perplexity's own documented search URL.",
  },
  google_ai_overview: {
    id: "google_ai_overview", label: "Google AI Overview", vendor: "Google", kind: "ai_overview",
    deeplink: p => "https://www.google.com/search?q=" + encodeURIComponent(p) + "&udm=50",
    deeplink_prefills: true,
    deeplink_basis: "google.com/search?q= is the standard search URL; udm=50 opens AI Mode.",
  },
  google_web: {
    id: "google_web", label: "Google / Web (organic)", vendor: "Google", kind: "serp",
    deeplink: p => "https://www.google.com/search?q=" + encodeURIComponent(p),
    deeplink_prefills: true,
    deeplink_basis: "google.com/search?q= is the standard search URL.",
  },
};

const PROVIDER_ORDER = ["chatgpt", "claude", "gemini", "perplexity", "google_ai_overview", "google_web"];
const LLM_SURFACES = ["chatgpt", "claude", "gemini", "perplexity"];

/* ------------------------------------------------------- brand extraction */

/**
 * Which tracked brands does this answer actually name, and in what order?
 *
 * Ordering is by first confirmed occurrence in the text. This is the only
 * defensible reading of "position" in prose: it is what the answer presents
 * first, it is reproducible, and the excerpt is kept so it can be verified.
 */
function brandsInText(text, { citations = [] } = {}) {
  const out = {};
  const found = [];

  for (const id of brandOrder()) {
    const m = matchBrand(text, id);
    if (!m.present) continue;

    // Locate the alias to derive both an offset and a quotable excerpt.
    const aliases = brand(id).aliases;
    let idx = -1, alias = null;
    for (const a of aliases) {
      const i = text.toLowerCase().indexOf(a.toLowerCase());
      if (i !== -1 && (idx === -1 || i < idx)) { idx = i; alias = a; }
    }
    if (idx === -1) continue; // matchBrand agreed but no literal alias — do not assert

    const start = Math.max(0, idx - 120);
    found.push({
      id,
      offset: idx,
      matched_alias: alias,
      evidence: text.slice(start, Math.min(text.length, idx + 220)).replace(/\s+/g, " ").trim(),
    });
  }

  // Rank by first appearance.
  found.sort((a, b) => a.offset - b.offset);
  found.forEach((f, i) => {
    // A citation on the brand's own domain is independent corroboration.
    const ownDomain = (brand(f.id) || {}).domain;
    const citedOwn = ownDomain
      ? citations.find(c => c.domain && String(c.domain).endsWith(ownDomain))
      : null;
    out[f.id] = {
      visible: true,
      position: i + 1,
      matched_alias: f.matched_alias,
      evidence: f.evidence,
      evidence_url: citedOwn ? citedOwn.url : null,
      cited_own_domain: !!citedOwn,
    };
  });

  // Everything else is a MEASURED absence — distinct from unchecked.
  for (const id of brandOrder()) {
    if (!out[id]) out[id] = { visible: false, position: null };
  }
  return { brands: out, total_named: found.length };
}

/** Untracked competitors the answer named — the denominator for share of voice. */
function otherProductsNamed(text) {
  // Only names that appear in a recognisably product-listing context, so this
  // does not scrape every capitalised word out of the prose.
  const KNOWN = [
    "Notion", "Zendesk", "Intercom", "Freshdesk", "Helpjuice", "Slab", "Nuclino",
    "Slite", "Tettra", "ProProfs", "Archbee", "ReadMe", "Docusaurus", "MadCap",
    "Paligo", "Stonly", "Guru", "Help Scout", "HubSpot", "Salesforce", "Glean",
    "Coveo", "Zoho", "Scribe", "Whatfix", "Assembly", "ClickHelp", "Heretto",
    "Redocly", "Stoplight", "Theneo", "Fern", "Mintlify", "GitBook", "Confluence",
  ];
  const tracked = new Set(allBrands().flatMap(b => b.aliases.map(a => a.toLowerCase())));
  const named = [];
  for (const k of KNOWN) {
    if (tracked.has(k.toLowerCase())) continue;
    if (new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) named.push(k);
  }
  return named;
}

/* ------------------------------------------------- unqueryable-surface layer */

/**
 * When a surface cannot be queried, attach what IS known about it from
 * first-party analytics.
 *
 * This is deliberately NOT presented as a visibility measurement. GA4 measures
 * a different thing — how many people actually arrived from that assistant —
 * and conflating "we rank #1 in ChatGPT" with "2,578 sessions came from ChatGPT"
 * would be sloppy. But when the alternative is a blank "not checked", the
 * outcome signal is the most useful honest thing to show, and it costs nothing.
 *
 * Returns null when there is no first-party signal for that surface.
 */
function referralFallback(providerId, referrals) {
  if (!referrals || !referrals.ok) return null;
  const s = (referrals.surfaces || []).find(x => x.id === providerId);
  if (!s) return null;
  return {
    kind: "first_party_referral_traffic",
    source: "Google Analytics 4 via Windsor.ai",
    label: `${s.sessions} session(s) arrived from ${s.label} in the last 90 days`,
    sessions: s.sessions,
    share_of_ai_pct: s.share_of_ai_pct,
    top_landing_pages: s.top_landing_pages.slice(0, 5),
    // The distinction that keeps this honest.
    caveat:
      "This is a different measurement from AI visibility: it counts visits that actually arrived from " +
      `${s.label}, not whether ${s.label} names the product in an answer. It is evidence the surface ` +
      "sends real traffic, not a rank.",
  };
}

/* ------------------------------------------------------------- LLM surface */

async function measureLlm(providerId, prompt, opts = {}) {
  const p = PROVIDERS[providerId];
  const { referrals = null, ...rest } = opts;
  const r = await dfs.llmResponse(providerId, prompt, rest);

  if (!r.ok) {
    // A skipped call is NOT_CHECKED. An errored call is FAILED. Different facts.
    return {
      status: r.skipped ? "not_checked" : "failed",
      label: p.label,
      reason: r.error,
      skipped_because: r.skipped || null,
      how_to_enable: r.skipped === "budget"
        ? "Top up the DataForSEO account, or raise DATAFORSEO_MAX_PROBE_COST in .env. Meanwhile the first-party referral figure below still applies."
        : r.skipped === "not_configured"
          ? "Add DATAFORSEO_B64 to .env, then run: npm run api:health"
          : null,
      estimated_cost: r.estimated_cost ?? null,
      checked_at: null,
      cost: r.cost || 0,
      // What we still know about this surface without asking it anything.
      fallback: referralFallback(providerId, referrals),
      open_search: p.deeplink(prompt),
    };
  }

  const { brands, total_named } = brandsInText(r.text, { citations: r.citations });

  return {
    status: "measured",
    label: p.label,
    model: r.model,
    web_search: r.web_search,
    method: `${p.label} (${r.model})${r.web_search ? ", web search enabled" : ""} via DataForSEO AI Optimization API — the model's own answer text.`,
    checked_at: r.answered_at,
    from_cache: !!r.from_cache,
    cost: r.cost || 0,

    // The actual answer. This is the evidence every rank below is derived from,
    // and it is stored in full so a rank is never an unverifiable assertion.
    answer_text: r.text,
    answer_length: r.text_length,

    brands,
    total_products_named: total_named,
    other_products_named: otherProductsNamed(r.text),

    // Corroboration, not a substitute: how much traffic this surface actually
    // sent. Shown alongside a measured rank so the two can be read together.
    referral_traffic: referralFallback(providerId, referrals),

    // Real citation URLs the model returned.
    citations: r.citations.map((c, i) => ({
      rank: i + 1,
      url: c.url,
      title: c.title,
      domain: c.domain,
      mentions: brandOrder().filter(id => {
        const blob = `${c.title || ""} ${c.domain || ""}`;
        return matchBrand(blob, id).present;
      }),
    })),

    // High, because this is a fetched answer we can quote — not a recollection.
    confidence: 0.95,
    open_search: p.deeplink(prompt),
  };
}

/* ------------------------------------------------- Google AI Overview surface */

async function measureAiOverview(prompt, opts = {}) {
  const p = PROVIDERS.google_ai_overview;
  const r = await dfs.googleAiOverview(prompt, opts);

  if (!r.ok) {
    return {
      status: r.skipped ? "not_checked" : "failed",
      label: p.label,
      reason: r.error,
      skipped_because: r.skipped || null,
      how_to_enable: r.skipped === "budget"
        ? "Top up the DataForSEO account, or raise DATAFORSEO_MAX_PROBE_COST in .env."
        : r.skipped === "not_configured" ? "Add DATAFORSEO_B64 to .env." : null,
      estimated_cost: r.estimated_cost ?? null,
      checked_at: null,
      cost: r.cost || 0,
      open_search: p.deeplink(prompt),
    };
  }

  // Google showing no AI Overview for a query is itself a measured result.
  if (!r.present) {
    return {
      status: "measured",
      label: p.label,
      method: "Google AI Mode via DataForSEO — Google returned no AI Overview for this query.",
      checked_at: r.measured_at,
      no_ai_overview: true,
      note: r.note,
      answer_text: "",
      brands: Object.fromEntries(brandOrder().map(id => [id, { visible: false, position: null }])),
      total_products_named: 0,
      citations: [],
      confidence: 0.95,
      cost: r.cost || 0,
      from_cache: !!r.from_cache,
      open_search: p.deeplink(prompt),
    };
  }

  const { brands, total_named } = brandsInText(r.text, { citations: r.citations });

  return {
    status: "measured",
    label: p.label,
    method: "Google AI Mode via DataForSEO — the AI Overview's own text and reference list.",
    checked_at: r.measured_at,
    from_cache: !!r.from_cache,
    cost: r.cost || 0,
    answer_text: r.text,
    answer_length: r.text_length,
    brands,
    total_products_named: total_named,
    other_products_named: otherProductsNamed(r.text),
    citations: r.citations.map((c, i) => ({
      rank: i + 1, url: c.url, title: c.title, domain: c.domain,
      mentions: brandOrder().filter(id => matchBrand(`${c.title || ""} ${c.domain || ""}`, id).present),
    })),
    confidence: 0.95,
    open_search: p.deeplink(prompt),
  };
}

/* ---------------------------------------------------------- Google web SERP */

/**
 * Ranked organic results.
 *
 * Prefers DataForSEO (real Google, $0.002) and falls back to SearXNG (free, but
 * a metasearch aggregate rather than Google itself). Which one produced the
 * numbers is always reported, because they are not the same measurement.
 */
async function measureSerp(prompt, { days = 365, log = () => {}, spentThisProbe = 0, preferDataForSeo = true, useCache = true } = {}) {
  if (preferDataForSeo && dfs.configured()) {
    const r = await dfs.googleOrganic(prompt, { spentThisProbe, log, useCache });
    if (r.ok) {
      return buildSerpResult(prompt, r.results, {
        method: "Google organic via DataForSEO — real ranked Google results.",
        source: "dataforseo_google",
        cost: r.cost || 0,
        from_cache: !!r.from_cache,
        checked_at: r.measured_at,
      });
    }
    // Budget-skipped or errored: fall through to SearXNG rather than give up.
    log(`      Google organic unavailable (${r.skipped || "error"}) — falling back to SearXNG`);
  }

  const provider = require("./serp-provider");
  const prov = await provider.resolve({ log });
  if (prov.unavailable) {
    return {
      status: "not_checked",
      label: PROVIDERS.google_web.label,
      reason: `No SERP source available. DataForSEO: ${dfs.configured() ? "budget or error" : "not configured"}. SearXNG: ${prov.note}`,
      checked_at: null,
      cost: 0,
      open_search: PROVIDERS.google_web.deeplink(prompt),
    };
  }

  const s = await prov.search(prompt, { days });
  if (!s.ok) {
    return {
      status: "failed",
      label: PROVIDERS.google_web.label,
      reason: `SERP query failed: ${s.error}`,
      checked_at: new Date().toISOString(),
      cost: 0,
      open_search: PROVIDERS.google_web.deeplink(prompt),
    };
  }
  // Zero results while engines are suspended is a FAILED measurement, not an
  // absence — recording it as "not visible" would be a false claim.
  if (!s.results.length && (s.unresponsive_engines || []).length) {
    return {
      status: "failed",
      label: PROVIDERS.google_web.label,
      reason:
        "Every upstream engine was rate-limited (" +
        (s.unresponsive_engines || []).map(e => (Array.isArray(e) ? e.join(": ") : e)).join(", ") +
        "), so nothing was measured. This is not the same as the brand being absent.",
      checked_at: new Date().toISOString(),
      cost: 0,
      open_search: PROVIDERS.google_web.deeplink(prompt),
    };
  }

  return buildSerpResult(prompt, s.results.slice(0, 20).map((h, i) => ({
    rank: i + 1, url: h.url, title: h.title || null, content: h.content || "",
    domain: (() => { try { return new URL(h.url).hostname.replace(/^www\./, ""); } catch (e) { return null; } })(),
    engine: h.engine || null,
  })), {
    method: `${prov.label} — metasearch aggregate, not Google itself. ${prov.note || ""}`.trim(),
    source: "searxng",
    cost: 0,
    checked_at: new Date().toISOString(),
    unresponsive_engines: s.unresponsive_engines || [],
  });
}

function buildSerpResult(prompt, results, meta) {
  const brands = {};
  results.forEach(h => {
    const blob = `${h.title || ""} ${h.content || ""}`;
    for (const id of brandOrder()) {
      const m = matchBrand(blob, id);
      if (m.present && !brands[id]) {
        brands[id] = {
          visible: true, position: h.rank,
          evidence: blob.replace(/\s+/g, " ").trim().slice(0, 280),
          evidence_url: h.url, matched_alias: m.matched || null,
        };
      }
    }
    // A brand's own domain ranking is stronger than a text mention.
    for (const b of allBrands()) {
      if (!b.domain || !h.domain || !h.domain.endsWith(b.domain)) continue;
      brands[b.id] = brands[b.id] || { visible: true, position: h.rank, evidence: h.title || "", evidence_url: h.url };
      brands[b.id].own_domain_rank = Math.min(brands[b.id].own_domain_rank || 999, h.rank);
    }
  });
  for (const id of brandOrder()) if (!brands[id]) brands[id] = { visible: false, position: null };

  return {
    status: "measured",
    label: PROVIDERS.google_web.label,
    result_count: results.length,
    brands,
    citations: results.map(h => ({
      rank: h.rank, url: h.url, title: h.title, domain: h.domain, engine: h.engine,
      mentions: brandOrder().filter(id => matchBrand(`${h.title || ""} ${h.content || ""}`, id).present),
    })),
    confidence: 0.95,
    open_search: PROVIDERS.google_web.deeplink(prompt),
    ...meta,
  };
}

/* --------------------------------------------------------- availability map */

function providerAvailability() {
  const configured = dfs.configured();
  const out = {};
  for (const id of PROVIDER_ORDER) {
    const p = PROVIDERS[id];
    let measurable = configured;
    let note = configured
      ? `Measured live via DataForSEO${dfs.PROVIDERS[id] ? ` (${dfs.PROVIDERS[id].model})` : ""}.`
      : "DataForSEO is not configured.";
    if (id === "google_web" && !configured) {
      // The one surface with a free fallback.
      measurable = true;
      note = "Measured via SearXNG (metasearch aggregate rather than Google itself).";
    }
    out[id] = {
      id, label: p.label, vendor: p.vendor, kind: p.kind,
      measurable, note,
      estimated_cost: id === "google_ai_overview" ? dfs.SERP_COSTS.ai_overview
        : id === "google_web" ? dfs.SERP_COSTS.organic
          : (dfs.PROVIDERS[id] || {}).est_cost ?? null,
      deeplink_prefills: p.deeplink_prefills,
      deeplink_basis: p.deeplink_basis,
    };
  }
  return out;
}

/* ------------------------------------------------------------ orchestration */

/**
 * Probe one prompt across the requested surfaces.
 *
 * Deliberately sequential. Each call is billable and the running total feeds the
 * budget guard, so firing them in parallel would let a probe overshoot its cap.
 */
async function probe(prompt, {
  brandId = "document360",
  days = 365,
  surfaces = null,
  cheap = false,
  useCache = true,
  maxTokens = 900,
  log = () => {},
} = {}) {
  const started = new Date().toISOString();
  const clean = String(prompt || "").trim();
  if (!clean) return { ok: false, error: "empty prompt" };
  if (clean.length > 500) return { ok: false, error: "prompt too long (max 500 chars)" };

  const want = surfaces && surfaces.length ? surfaces.filter(s => PROVIDERS[s]) : PROVIDER_ORDER;
  const estimate = dfs.estimateProbeCost({ surfaces: want, cheap });

  log(`  probing "${clean.slice(0, 70)}" across ${want.length} surface(s), est. $${estimate.total.toFixed(4)}`);

  const balanceBefore = dfs.configured() ? await dfs.balance() : null;
  if (balanceBefore && balanceBefore.ok) {
    log(`    DataForSEO balance: $${Number(balanceBefore.balance).toFixed(4)}`);
  }

  /* First-party referral traffic, fetched once for the whole probe.
   * Free, cached for an hour, and the thing that keeps a budget-blocked surface
   * from rendering as an empty "not checked". */
  let referrals = null;
  if (windsor.configured()) {
    const rr = await windsor.aiReferrals({ log });
    if (rr.ok) {
      referrals = rr;
      log(`    first-party: ${rr.ai_sessions} AI session(s) across ${rr.surfaces.length} surface(s) (${rr.ai_share_pct}% of traffic)`);
    } else {
      log(`    first-party referral data unavailable: ${String(rr.error).slice(0, 90)}`);
    }
  }

  const providers = {};
  let spent = 0;

  for (const id of want) {
    const p = PROVIDERS[id];
    let res;
    if (p.kind === "llm") {
      res = await measureLlm(id, clean, { cheap, useCache, maxTokens, spentThisProbe: spent, referrals, log });
    } else if (p.kind === "ai_overview") {
      res = await measureAiOverview(clean, { useCache, spentThisProbe: spent, log });
    } else {
      res = await measureSerp(clean, { days, useCache, spentThisProbe: spent, log });
    }
    spent += res.cost || 0;
    providers[id] = res;
  }

  const measured = Object.values(providers).filter(x => x.status === "measured").length;
  const balanceAfter = dfs.configured() ? await dfs.balance() : null;

  log(`    measured ${measured}/${want.length} surface(s), spent $${spent.toFixed(4)}`);

  return {
    ok: true,
    prompt: clean,
    brand_id: brandId,
    probed_at: started,
    completed_at: new Date().toISOString(),
    providers,
    availability: providerAvailability(),
    // The first-party layer, exposed whole so the UI can render its own panel.
    referrals: referrals ? {
      method: referrals.method,
      total_sessions: referrals.total_sessions,
      ai_sessions: referrals.ai_sessions,
      ai_share_pct: referrals.ai_share_pct,
      surfaces: referrals.surfaces,
      top_landing_pages: referrals.top_landing_pages,
      by_date: referrals.by_date,
      scope_limit: referrals.scope_limit,
      fetched_at: referrals.fetched_at,
    } : null,
    // Cost is surfaced in the UI: a measurement that costs money should say so.
    cost: {
      estimated: estimate.total,
      actual: Math.round(spent * 1e6) / 1e6,
      balance_before: balanceBefore && balanceBefore.ok ? balanceBefore.balance : null,
      balance_after: balanceAfter && balanceAfter.ok ? balanceAfter.balance : null,
      per_surface: estimate.lines,
    },
    surfaces_requested: want,
    surfaces_measured: measured,
  };
}

module.exports = {
  PROVIDERS, PROVIDER_ORDER, LLM_SURFACES,
  probe, measureSerp, measureLlm, measureAiOverview,
  providerAvailability, brandsInText, otherProductsNamed,
};
