/**
 * AI Visibility history + metrics.
 *
 * Every probe is appended here so visibility can be tracked over time rather
 * than only sampled once. The file is the single source for requirement 8's
 * metrics, and every metric is computed over MEASURED checks only.
 *
 * WHY THAT DENOMINATOR MATTERS MORE THAN THE METRIC
 * ------------------------------------------------
 * Four of the five AI surfaces cannot be queried on this deployment. If
 * unchecked surfaces were counted as "not visible", every rate would be
 * silently divided by five instead of by one, and Document360 would appear to
 * have ~20% of its real AI visibility. So a check contributes to a denominator
 * only when status === "measured"; `coverage` reports what fraction of attempted
 * checks that was, so a reader can see how much of the picture is missing.
 */
const path = require("path");
const fs = require("fs");
const { brandOrder, brand } = require("./brands");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const HISTORY = path.join(DATA_DIR, "ai-history.json");
const MAX_ENTRIES = 2000;

function readHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(HISTORY, "utf8"));
    return Array.isArray(j.entries) ? j : { entries: [] };
  } catch (e) {
    return { entries: [] };
  }
}

function writeHistory(h) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HISTORY, JSON.stringify(h, null, 2));
}

/**
 * Flatten one probe into per-(prompt, provider, brand) observations. Storing the
 * flat form is what makes the metrics computable without re-parsing provider
 * shapes, and keeps each observation individually traceable to its evidence.
 */
function flatten(probeResult) {
  const rows = [];
  const at = probeResult.probed_at;
  for (const [providerId, p] of Object.entries(probeResult.providers || {})) {
    const measured = p.status === "measured";
    if (!measured) {
      // Recorded, so coverage can be computed — but with no visibility claim.
      rows.push({
        prompt: probeResult.prompt,
        provider: providerId,
        brand_id: null,
        status: p.status,
        reason: p.reason || null,
        visible: null,
        position: null,
        at,
      });
      continue;
    }
    for (const id of brandOrder()) {
      const b = (p.brands || {})[id] || { visible: false, position: null };
      rows.push({
        prompt: probeResult.prompt,
        provider: providerId,
        brand_id: id,
        status: "measured",
        visible: !!b.visible,
        position: b.position ?? null,
        own_domain_rank: b.own_domain_rank ?? null,
        evidence: b.evidence || null,
        evidence_url: b.evidence_url || null,
        at,
      });
    }
  }
  return rows;
}

/** Append a probe result. Returns the stored entry. */
function record(probeResult) {
  const h = readHistory();
  const entry = {
    id: "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    prompt: probeResult.prompt,
    brand_id: probeResult.brand_id,
    probed_at: probeResult.probed_at,
    providers: probeResult.providers,
    observations: flatten(probeResult),
  };
  h.entries.unshift(entry);
  // Bound the file. Oldest first out; the metrics are dominated by recent data
  // anyway and an unbounded JSON store eventually breaks the server read.
  if (h.entries.length > MAX_ENTRIES) h.entries.length = MAX_ENTRIES;
  h.updated_at = new Date().toISOString();
  writeHistory(h);
  return entry;
}

/**
 * Requirement 8 metrics for one brand.
 *
 * `recommendation_rate` is intentionally distinct from `mention_rate`: being
 * named anywhere in a result set is weaker than being named in a position that
 * constitutes a recommendation. Top-5 is used as the recommendation threshold
 * and the definition is reported alongside the number, because an unexplained
 * rate invites the reader to assume a different definition than the one used.
 */
function metrics(brandId, { since = null, provider = null } = {}) {
  const h = readHistory();
  const cutoff = since ? new Date(since).getTime() : null;

  const obs = [];
  const providerStatuses = [];
  for (const e of h.entries) {
    if (cutoff && new Date(e.probed_at).getTime() < cutoff) continue;
    for (const o of e.observations || []) {
      if (provider && o.provider !== provider) continue;
      if (o.brand_id === null) { providerStatuses.push(o); continue; }
      obs.push(o);
    }
  }

  const mine = obs.filter(o => o.brand_id === brandId && o.status === "measured");
  const measuredChecks = mine.length;
  const visible = mine.filter(o => o.visible);
  const positions = visible.map(o => o.position).filter(p => p != null);

  // Share of AI voice: this brand's visible observations as a fraction of ALL
  // tracked brands' visible observations over the same checks.
  const allVisible = obs.filter(o => o.status === "measured" && o.visible).length;

  const attempted = measuredChecks + providerStatuses.length;

  const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

  return {
    brand_id: brandId,
    brand: brand(brandId) ? brand(brandId).name : brandId,
    window_since: since || null,
    provider_filter: provider || null,

    prompts_probed: new Set(
      h.entries.filter(e => !cutoff || new Date(e.probed_at).getTime() >= cutoff).map(e => e.prompt)
    ).size,

    // Denominators, stated so no rate has to be taken on trust.
    checks_measured: measuredChecks,
    checks_not_measured: providerStatuses.length,
    coverage_pct: rate(measuredChecks, attempted),

    ai_mention_rate: rate(visible.length, measuredChecks),
    recommendation_rate: rate(positions.filter(p => p <= 5).length, measuredChecks),
    recommendation_rate_definition: "share of measured checks where the brand placed in the top 5",

    average_position: positions.length
      ? Math.round((positions.reduce((a, b) => a + b, 0) / positions.length) * 10) / 10
      : null,
    best_position: positions.length ? Math.min(...positions) : null,
    top3_rate: rate(positions.filter(p => p <= 3).length, measuredChecks),
    top5_rate: rate(positions.filter(p => p <= 5).length, measuredChecks),

    share_of_ai_voice: rate(visible.length, allVisible),

    // null rather than 0 when there is nothing to compute from, so the UI can
    // say "not measured yet" instead of showing a confident zero.
    has_data: measuredChecks > 0,
  };
}

/** Metrics for every tracked brand — the share-of-voice table. */
function allMetrics(opts = {}) {
  return brandOrder().map(id => metrics(id, opts));
}

/**
 * Prompts where the brand is NOT visible despite the check succeeding.
 * This is the input to requirement 3: recommendations attach to these.
 */
function gaps(brandId, { since = null } = {}) {
  const h = readHistory();
  const cutoff = since ? new Date(since).getTime() : null;
  const out = [];
  const seen = new Set();

  for (const e of h.entries) {
    if (cutoff && new Date(e.probed_at).getTime() < cutoff) continue;
    for (const [providerId, p] of Object.entries(e.providers || {})) {
      if (p.status !== "measured") continue;
      const b = (p.brands || {})[brandId];
      const key = e.prompt + "|" + providerId;
      if (seen.has(key)) continue;
      seen.add(key);
      if (b && b.visible) continue;

      // Who DID appear, and from which sources — the evidence a recommendation
      // must be built on rather than generic advice.
      const competitors = Object.entries(p.brands || {})
        .filter(([id, v]) => id !== brandId && v.visible)
        .map(([id, v]) => ({
          brand_id: id,
          name: brand(id) ? brand(id).name : id,
          position: v.position,
          evidence_url: v.evidence_url || null,
        }))
        .sort((a, c) => (a.position || 99) - (c.position || 99));

      out.push({
        prompt: e.prompt,
        provider: providerId,
        probed_at: e.probed_at,
        entry_id: e.id,
        competitors,
        citations: (p.citations || []).slice(0, 12),
      });
    }
  }
  return out;
}

module.exports = { HISTORY, readHistory, record, metrics, allMetrics, gaps, flatten };
