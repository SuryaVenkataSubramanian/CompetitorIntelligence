/**
 * Builds data/*.json from the verified evidence store.
 *
 *   node collectors/build.js
 *
 * Rules this file enforces, because the dashboard renders whatever it emits:
 *
 * 1. ONLY records passing isVerified() are emitted. Unverified ones go to
 *    data/audit.json so their exclusion is inspectable.
 * 2. Date ranges are computed for real. A record with date_confidence "unknown"
 *    is NOT in any range bucket; it is counted separately as `undated` and shown
 *    as such. The old dashboard's 30/90/365 presets silently returned everything.
 * 3. Sentiment totals count only classified records. `unclassified` is its own
 *    number, never folded into neutral.
 * 4. Per-range, per-channel coverage caveats travel with the data, so the UI can
 *    say "this 365d figure is a floor" where that is true.
 */
const fs = require("fs");
const path = require("path");
const { loadMentions, readJson, STORE_DIR } = require("./lib/store");
const { isVerified, isDateUsable, rejectionReason, CHANNELS, CHANNEL_IDS, CHANNEL_GROUPS, normaliseChannel, verificationStatus } = require("./lib/record");
const { keyStatus } = require("./lib/env");
const { allBrands, brandOrder, brand, config } = require("./lib/brands");

// Credential-gated adapters are asked directly whether they are connected, so
// dormancy reflects the current environment rather than the last collector run.
const CREDENTIAL_ADAPTERS = [require("./adapters/linkedin"), require("./adapters/x_twikit")];

const DATA = path.join(__dirname, "..", "data");
const RANGES = [7, 30, 90, 365];

function w(file, obj) {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, file), JSON.stringify(obj, null, 2));
  console.log("  ✓ data/" + file);
}

function daysAgo(iso, now) {
  return Math.floor((now - new Date(iso + "T00:00:00Z")) / 864e5);
}

/* ------------------------------------------------------------------ load */

const store = loadMentions();
const now = new Date();
const nowMs = now.getTime();

const verified = store.records.filter(isVerified);
const unverified = store.records.filter(r => !isVerified(r));
const coverage = readJson(path.join(STORE_DIR, "coverage.json"), null);
const ai = readJson(path.join(STORE_DIR, "ai-visibility.json"), null);
const recs = readJson(path.join(STORE_DIR, "recommendations.json"), null);
const legacyRejected = readJson(path.join(STORE_DIR, "legacy-rejected.json"), null);

/* --------------------------------------------------------------- mentions */

/**
 * Emit only the fields the UI needs, keeping provenance visible.
 *
 * TWO DATE AXES, because one is not enough and conflating them would lie:
 *
 *   published_at  - proven from the page or an authoritative feed. Preferred.
 *   first_seen    - when OUR collector first recorded the mention. Always known.
 *
 * 34% of search-discovered pages expose no machine-readable publication date, so
 * a range filter on `published_at` alone silently hid a third of the dataset —
 * a "last 90 days" view showed 27 of 129 Document360 records.
 *
 * So range filters run on `effective_date`, and every record carries
 * `date_basis` saying which axis produced it. A record dated by discovery is
 * labelled as such in the UI, because "published in the last 7 days" and "we
 * first saw it in the last 7 days" are different business facts and a reader
 * must be able to tell them apart.
 */
function toWire(r) {
  const firstSeen = (r.first_seen || r.fetched_at || null);
  const firstSeenDay = firstSeen ? String(firstSeen).slice(0, 10) : null;
  const effective = r.published_at || firstSeenDay;
  return {
    brand: r.brand_id,
    channel: normaliseChannel(r.channel),
    url: r.url,
    domain: r.domain,
    title: r.title,
    author: r.author || null,
    date: r.published_at || null,
    date_confidence: r.date_confidence,
    date_method: r.date_method || null,
    days_ago: r.published_at ? daysAgo(r.published_at, nowMs) : null,

    first_seen: firstSeenDay,
    effective_date: effective,
    date_basis: r.published_at ? "published" : (firstSeenDay ? "discovered" : "none"),
    effective_days_ago: effective ? Math.max(0, daysAgo(effective, nowMs)) : null,

    // API-provider + classification fields, surfaced so the UI can show which
    // system produced each value rather than presenting them all as equivalent.
    api_source: r.api_source || r.source_adapter,
    verification_status: verificationStatus(r),
    relevance_score: r.relevance_score ?? null,
    relevance_comment: r.relevance_comment || null,
    confidence_score: r.confidence_score ?? null,
    mention_type: r.mention_type || null,
    mention_type_basis: r.mention_type_basis || null,
    buying_intent: !!r.buying_intent,
    buying_intent_basis: r.buying_intent_basis || null,
    comparison_products: r.comparison_products || [],
    is_event: !!r.is_event,
    is_sponsorship: !!r.is_sponsorship,
    event_basis: r.event_basis || null,
    engagement: r.engagement || null,
    provider_tags: r.provider_tags || [],
    also_seen_in: r.also_seen_in || [],
    sentiment: r.sentiment || null,
    sentiment_method: r.sentiment_method || null,
    sentiment_quote: r.sentiment_quote || null,
    sentiment_rationale: r.sentiment_rationale || null,
    evidence: r.evidence,
    evidence_source: r.evidence_source,
    source: r.source_adapter,
    link_ok: !!r.url_verified,
    http_status: r.http_status,
    verified_via: r.verification_method,
    matched_alias: r.matched_alias,
    match_context: r.match_context_term || null,
    fetched_at: r.fetched_at,
    extra: r.extra || {},
  };
}

const wire = verified.map(toWire);

/** Counts for one set of records: by channel, sentiment, and date bucket. */
function summarise(records) {
  const byChannel = {};
  for (const c of CHANNEL_IDS) byChannel[c] = 0;
  const sentiment = { positive: 0, negative: 0, neutral: 0, unclassified: 0 };
  let dated = 0;
  let linkOk = 0;

  for (const r of records) {
    byChannel[r.channel] = (byChannel[r.channel] || 0) + 1;
    sentiment[r.sentiment || "unclassified"]++;
    if (r.date_confidence === "exact") dated++;
    if (r.link_ok) linkOk++;
  }

  // Range buckets run on the effective date (published, else discovered) so a
  // page with no machine-readable date is still usable. `by_basis` reports how
  // many rows in each bucket were dated by discovery rather than publication, so
  // the split is always visible rather than assumed.
  const ranges = {};
  for (const d of RANGES) {
    const inRange = records.filter(r => r.effective_days_ago != null && r.effective_days_ago <= d);
    const rs = { positive: 0, negative: 0, neutral: 0, unclassified: 0 };
    const rc = {};
    for (const c of CHANNEL_IDS) rc[c] = 0;
    let byPublished = 0;
    for (const r of inRange) {
      rs[r.sentiment || "unclassified"]++;
      rc[r.channel] = (rc[r.channel] || 0) + 1;
      if (r.date_basis === "published") byPublished++;
    }
    ranges[d] = {
      total: inRange.length,
      sentiment: rs,
      by_channel: rc,
      by_basis: { published: byPublished, discovered: inRange.length - byPublished },
      // Kept for comparison: how small the bucket would be on published dates alone.
      published_only: records.filter(r => r.days_ago != null && r.days_ago <= d).length,
    };
  }

  /* Business metrics the brief asks for. Each is computed only from the records
   * present, so a metric is never extrapolated — and growth is null rather than
   * 0% when the prior period has no data to compare against, because "no
   * baseline" and "flat" are different answers. */
  const inWindow = d => records.filter(r => r.effective_days_ago != null && r.effective_days_ago <= d);
  const inPrior = d =>
    records.filter(r => r.effective_days_ago != null && r.effective_days_ago > d && r.effective_days_ago <= d * 2);

  const growth = {};
  for (const d of RANGES) {
    const cur = inWindow(d).length;
    const prev = inPrior(d).length;
    growth[d] = {
      current: cur,
      previous: prev,
      // null, not 0, when there is no prior-period baseline.
      change_pct: prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null,
      absolute: cur - prev,
    };
  }

  const byType = {};
  const byApiSource = {};
  const byVerification = { verified: 0, provider: 0, unverified: 0 };
  let buyingIntent = 0, events = 0, sponsorships = 0, comparisons = 0;
  const comparisonPairs = {};
  for (const r of records) {
    if (r.mention_type) byType[r.mention_type] = (byType[r.mention_type] || 0) + 1;
    byApiSource[r.api_source] = (byApiSource[r.api_source] || 0) + 1;
    byVerification[r.verification_status] = (byVerification[r.verification_status] || 0) + 1;
    if (r.buying_intent) buyingIntent++;
    if (r.is_event) events++;
    if (r.is_sponsorship) sponsorships++;
    if ((r.comparison_products || []).length) {
      comparisons++;
      for (const c of r.comparison_products) {
        comparisonPairs[c.name] = (comparisonPairs[c.name] || 0) + 1;
      }
    }
  }

  return {
    total: records.length,
    dated,
    undated: records.length - dated,
    link_ok: linkOk,
    link_broken: records.length - linkOk,
    by_channel: byChannel,
    sentiment,
    ranges,
    growth,
    by_mention_type: byType,
    by_api_source: byApiSource,
    by_verification: byVerification,
    buying_intent: buyingIntent,
    events,
    sponsorships,
    comparisons,
    compared_against: comparisonPairs,
  };
}

const brands = {};
for (const b of allBrands()) {
  const mine = wire.filter(r => r.brand === b.id);
  brands[b.id] = {
    id: b.id,
    name: b.name,
    domain: b.domain,
    vendor: b.vendor || null,
    primary: !!b.primary,
    ambiguous: !!b.ambiguous,
    ambiguity_note: b.ambiguity_note || null,
    channel_sources: {
      blog: b.blog_feed ? { type: "first-party RSS", endpoint: b.blog_feed } : { type: "none", note: b.blog_feed_note || null },
      video: b.youtube_feed ? { type: "owned YouTube channel RSS", endpoint: b.youtube_feed } : { type: "none", note: b.youtube_note || null },
      linkedin: { type: "credential-gated", slug: b.linkedin_slug || null },
      x: { type: "credential-gated", handle: b.x_handle || null },
    },
    stats: summarise(mine),
    mentions: mine.sort((a, c) => {
      // Newest first; undated last rather than interleaved at the epoch.
      if (a.days_ago == null && c.days_ago == null) return 0;
      if (a.days_ago == null) return 1;
      if (c.days_ago == null) return -1;
      return a.days_ago - c.days_ago;
    }),
  };
}

/* ------------------------------------------------------- coverage caveats */

/**
 * Which limits apply to which range. This is what stops the dashboard from
 * quietly presenting a partial number as a total.
 */
function buildCaveats() {
  const out = { global: [], by_range: {}, by_channel: {}, dormant: [] };

  for (const d of RANGES) out.by_range[d] = [];

  // GDELT's rolling window makes long ranges thinner for news.
  out.by_range[365].push(
    "GDELT news indexing covers only a ~90-day rolling window, so 365-day web/news counts are thinner than reality."
  );
  out.by_range[90].push(
    "GDELT is at the edge of its ~90-day window here; some older news may be missing."
  );

  // YouTube feed cap.
  const capped = (coverage?.gaps || []).filter(g => g.adapter === "youtube" && /15 most recent/.test(g.reason));
  if (capped.length) {
    out.by_channel.video = [
      `YouTube's RSS feed returns only the 15 most recent uploads. For ${capped.length} brand(s) the whole feed fell inside the window, so video counts are a floor, not a total.`,
    ];
  }

  // Which SERP provider served the last run, and what it could not reach.
  const sp = coverage && coverage.serp_provider;
  if (sp) {
    out.serp_provider = sp;
    if (sp.id === "builtin") {
      out.global.push(
        `Web search for this build was served by the built-in Node metasearch, not SearXNG. ${sp.note}`
      );
      for (const ch of (sp.capabilities && sp.capabilities.cannot_serve_channels) || []) {
        out.by_channel[ch] = out.by_channel[ch] || [];
        out.by_channel[ch].push(
          "Not measurable with the current SERP provider (the built-in metasearch does not honour " +
            "site: or qualifier terms). Run SearXNG — npm run searxng:local — to populate this channel."
        );
      }
    } else if (sp.id === "none") {
      out.global.push(`No SERP provider was available for this build. ${sp.note}`);
    }
  }

  // Rate-limited SERP queries are measurement failures, not zeros. Surface them
  // per channel so a 0 that came from throttling is never read as "no activity".
  const rateLimited = (coverage?.gaps || []).filter(g => /rate-limited|MEASUREMENT FAILURE/i.test(g.reason || ""));
  if (rateLimited.length) {
    const byChannel = {};
    for (const g of rateLimited) {
      const m = /the (\w+) channel is under-reported for ([^.]+)\./.exec(g.reason || "");
      if (!m) continue;
      byChannel[m[1]] = byChannel[m[1]] || new Set();
      byChannel[m[1]].add(m[2]);
    }
    for (const [ch, brandsSet] of Object.entries(byChannel)) {
      out.by_channel[ch] = out.by_channel[ch] || [];
      out.by_channel[ch].push(
        `Under-reported for ${[...brandsSet].join(", ")}: upstream search engines rate-limited those ` +
          `queries, so the figure is a measurement failure rather than a real zero. Re-run collection later.`
      );
    }
    out.global.push(
      `${rateLimited.length} search quer${rateLimited.length === 1 ? "y was" : "ies were"} blocked by upstream ` +
        `engine rate limits during collection. Affected channels are flagged individually.`
    );
  }

  // Brands with no first-party blog feed.
  const noBlog = allBrands().filter(b => !b.blog_feed);
  if (noBlog.length) {
    out.by_channel.blog = [
      `${noBlog.map(b => b.name).join(", ")} publish no discoverable RSS feed, so their blog coverage depends on SearXNG/GDELT discovery and is less complete than brands with a feed.`,
    ];
  }

  // Dormant sources are evaluated LIVE from the adapters, not read from the last
  // run's coverage.json. A partial run (--only=…) would otherwise drop the
  // "LinkedIn not connected" notice entirely, and a missing warning reads as
  // "this channel is fine" — the exact silent degradation this build guards against.
  for (const ad of CREDENTIAL_ADAPTERS) {
    const status = typeof ad.connectionStatus === "function" ? ad.connectionStatus() : null;
    const avail = typeof ad.available === "function" ? ad.available() : { ok: true };
    if (status && status.connected) continue;
    if (!status && avail.ok) continue;
    out.dormant.push({
      adapter: ad.id,
      label: ad.label,
      blockers: status ? status.blockers : [avail.reason || "unavailable"],
      how_to_enable: (status && status.how_to_enable) || null,
      fallback_in_use: (status && status.fallback_in_use) || null,
    });
  }

  // SearXNG is a service rather than a credential, so its reachability is taken
  // from the last run that actually probed it.
  const searxRun = (coverage?.adapters || []).find(a => a.adapter === "searxng");
  if (!searxRun) {
    // Not probed in the last run (e.g. a --only= run). "Unknown" is stated rather
    // than omitted, because omitting it would imply the source is fine.
    out.dormant.push({
      adapter: "searxng",
      label: "SearXNG metasearch (self-hosted)",
      blockers: [
        coverage
          ? `Not probed in the last collector run (${coverage.finished_at || "unknown time"}), so its status is unknown. Channels that depend on it — Events, SERP/Web-AI-Overview, Google News resolution — may be stale or empty.`
          : "No collector run recorded, so SearXNG status is unknown.",
      ],
      how_to_enable: "npm run searxng:up  then  npm run collect",
      fallback_in_use: null,
    });
  } else if (searxRun.status === "dormant") {
    out.dormant.push({
      adapter: "searxng",
      label: searxRun.label,
      blockers: [(coverage.gaps || []).find(g => g.adapter === "searxng")?.reason || "not reachable"],
      how_to_enable: "npm run searxng:up  (then re-run npm run collect)",
      fallback_in_use: null,
    });
  }

  // Any adapter that errored or was rate-limited in the last run.
  for (const ad of coverage?.adapters || []) {
    if (ad.adapter === "searxng") continue;
    if (ad.status !== "error") continue;
    out.global.push(`${ad.label} failed on the last run: ${ad.error}`);
  }
  const gdeltLimited = (coverage?.gaps || []).filter(g => g.adapter === "gdelt" && /429|rate/i.test(g.reason));
  if (gdeltLimited.length) {
    out.global.push(
      `GDELT rate-limited ${gdeltLimited.length} request(s) on the last run (it allows 1 req/5s). ` +
        `News coverage from that source is incomplete for this build.`
    );
  }

  const linkedinDormant = out.dormant.find(d => d.adapter === "linkedin");
  const xDormant = out.dormant.find(d => d.adapter === "x_twikit");
  const searxDormant = out.dormant.find(d => d.adapter === "searxng");

  // How these two channels are described depends on whether SearXNG is filling
  // them. Saying "no LinkedIn data is shown" while 15 SearXNG-sourced LinkedIn
  // records sit in the table would be as misleading as the reverse.
  const searxWorking = sp && sp.id === "searxng";
  const countIn = ch => wire.filter(r => r.channel === ch).length;

  if (linkedinDormant) {
    const n = countIn("linkedin");
    out.by_channel.linkedin = [
      n > 0
        ? `The ${n} LinkedIn record(s) shown come from SearXNG \`site:linkedin.com\` discovery, which finds ` +
          `only publicly indexed posts — so this is a FLOOR, not a total. The credential-based collector ` +
          `(joeyism/linkedin_scraper) is not connected, so engagement metrics (reactions, comments, reposts) ` +
          `are unavailable and non-indexed posts are missed.`
        : "LinkedIn is not connected and no data is shown. Nothing is estimated." +
          (searxDormant ? " The SearXNG fallback is also unavailable, so this channel is empty." : ""),
    ];
  }
  if (xDormant) {
    const n = countIn("x");
    out.by_channel.x = [
      n > 0
        ? `The ${n} X record(s) shown come from SearXNG \`site:x.com\` discovery, which finds only publicly ` +
          `indexed posts — a FLOOR, not a total. The credential-based collector (twikit) is not connected, ` +
          `so like/repost counts are unavailable and unindexed posts are missed.`
        : "X is not connected and no data is shown. Nothing is estimated." +
          (searxDormant ? " The SearXNG fallback is also unavailable, so this channel is empty." : ""),
    ];
  }
  if (searxWorking) {
    const ev = countIn("event");
    out.by_channel.event = [
      ev > 0
        ? `Event sponsorship is detected by requiring BOTH a brand name and a sponsorship term on a ` +
          `fetched page — sponsorship is exposed by no API. ${ev} record(s) passed. Mere attendance or a ` +
          `speaking slot is deliberately not counted as sponsorship, so this under-reports event presence.`
        : `No sponsorship evidence met the bar (brand name AND an explicit sponsorship term on the page). ` +
          `Attendance and speaking slots are deliberately excluded.`,
    ];
  }
  if (searxDormant) {
    out.global.push(
      "SearXNG is not running, so SERP-based discovery, Google News link resolution, the Events channel and the Web/AI-Overview column are all unavailable. Start it: docker compose -f collectors/searxng/docker-compose.yml up -d"
    );
    if (!out.by_channel.event) {
      out.by_channel.event = [
        "Event-sponsorship detection requires SearXNG (sponsorship is not exposed by any API). This channel is empty until SearXNG is running.",
      ];
    }
  }

  return out;
}

/* --------------------------------------------------------------- outputs */

const totals = summarise(wire);
const classified = wire.filter(r => r.sentiment).length;

/**
 * Share of voice per product, per range. Denominator is all seven products in
 * that same range, so the figures always sum to 100% and cannot be read as an
 * absolute market share.
 */
const shareOfVoice = {};
for (const d of RANGES) {
  const perBrand = {};
  let tot = 0;
  for (const id of brandOrder()) {
    const n = brands[id].stats.ranges[d].total;
    perBrand[id] = n;
    tot += n;
  }
  shareOfVoice[d] = {
    total: tot,
    by_brand: Object.fromEntries(
      brandOrder().map(id => [
        id,
        { mentions: perBrand[id], share_pct: tot ? Math.round((perBrand[id] / tot) * 1000) / 10 : null },
      ])
    ),
  };
}

/**
 * Data Quality — every number here is a real counter from this build, so the
 * panel is a functioning audit rather than decoration. `ai_classified` is kept
 * separate from `verified` throughout: a fetched-and-confirmed fact and a model's
 * judgement are different grades of evidence and must not be summed.
 */
function buildDataQuality() {
  const dedupeReport = readJson(path.join(STORE_DIR, "dedupe-report.json"), null);
  const providerStats = (coverage && coverage.provider_stats) || {};
  const runs = readJson(path.join(STORE_DIR, "runs.json"), { runs: [] });

  const apiErrors = [];
  for (const [adapter, s] of Object.entries(providerStats)) {
    for (const e of s.api_errors || []) {
      apiErrors.push({ adapter, error: typeof e === "string" ? e : `${e.brand}: ${e.error}` });
    }
  }
  for (const ad of (coverage && coverage.adapters) || []) {
    if (ad.status === "error") apiErrors.push({ adapter: ad.adapter, error: ad.error });
  }

  const lowRelevance = wire.filter(r => r.relevance_score != null && r.relevance_score < 0.4).length;
  const uncertain = wire.filter(r => r.confidence_score != null && r.confidence_score < 0.7).length;
  const missingUrl = wire.filter(r => !r.url || !/^https?:\/\//.test(r.url)).length;

  // Rejections are grouped by reason so the panel explains WHY records were
  // dropped rather than only how many.
  const rejectionsByReason = {};
  for (const rj of (coverage && coverage.rejections) || []) {
    const k = String(rj.reason || "unknown").replace(/"[^"]*"/g, '"…"').slice(0, 90);
    rejectionsByReason[k] = (rejectionsByReason[k] || 0) + 1;
  }

  return {
    records_retrieved: store.records.length,
    records_verified: wire.filter(r => r.verification_status === "verified").length,
    records_provider_only: wire.filter(r => r.verification_status === "provider").length,
    records_ai_classified: classified,
    records_unclassified: totals.total - classified,
    duplicates_removed: dedupeReport ? dedupeReport.removed : 0,
    duplicates_by_reason: dedupeReport ? dedupeReport.by_reason : {},
    cross_source_corroborated: wire.filter(r => (r.also_seen_in || []).length).length,
    low_relevance_records: lowRelevance,
    missing_urls: missingUrl,
    uncertain_classifications: uncertain,
    links_verified_working: totals.link_ok,
    links_broken: totals.link_broken,
    rejected_this_run: (coverage && coverage.rejection_total) || 0,
    rejected_by_reason: rejectionsByReason,
    api_errors: apiErrors,
    by_api_source: totals.by_api_source,
    by_verification: totals.by_verification,
    last_successful_sync: (coverage && coverage.finished_at) || null,
    last_sync_window_days: (coverage && coverage.window_days) || null,
    total_runs_logged: (runs.runs || []).length,
    provider_stats: providerStats,
    // Which credentials are loaded — presence only, never the key itself.
    credentials: ["OCTOLENS_API_KEY", "NEWSAPI_KEY"].map(k => keyStatus(k)),
  };
}

const dates = wire.map(r => r.date).filter(Boolean).sort();

w("meta.json", {
  built_at: now.toISOString(),
  store_updated_at: store.updated_at,
  brand_order: brandOrder(),
  // Every alias per product, so the UI can highlight all variants it may appear
  // as in a mention body (e.g. "Document 360" as well as "Document360").
  brand_aliases: Object.fromEntries(brandOrder().map(id => [id, brand(id).aliases])),
  channels: CHANNEL_IDS.map(id => ({ id, label: CHANNELS[id].label, order: CHANNELS[id].order, group: CHANNELS[id].group })),
  channel_groups: Object.values(CHANNEL_GROUPS),
  ranges: RANGES,
  data_window: {
    earliest_dated_mention: dates[0] || null,
    latest_dated_mention: dates[dates.length - 1] || null,
    note:
      "Range filters operate only on records with a verified publication date. " +
      `${totals.undated} of ${totals.total} verified records have no provable date and are excluded from every range bucket (shown separately as "undated").`,
  },
  integrity: {
    verified_records: totals.total,
    unverified_excluded: unverified.length,
    with_exact_date: totals.dated,
    without_date: totals.undated,
    links_verified_working: totals.link_ok,
    links_broken: totals.link_broken,
    sentiment_classified: classified,
    sentiment_unclassified: totals.total - classified,
    classification_engine: "claude-code, grounded quote verified against the evidence excerpt",
    rule: "No field in this dataset was produced without either fetched bytes or a mechanically verified Claude judgement.",
  },
  caveats: buildCaveats(),
  totals,
  share_of_voice: shareOfVoice,
  data_quality: buildDataQuality(),
  last_updated: new Date().toISOString(),
  data_freshness: (() => {
    const ds = wire.map(r => r.date).filter(Boolean).sort();
    const newest = ds[ds.length - 1] || null;
    return {
      newest_published: newest,
      newest_published_age_days: newest ? daysAgo(newest, nowMs) : null,
      store_updated_at: store.updated_at,
      last_collector_run: (coverage && coverage.finished_at) || null,
    };
  })(),
});

w("brands.json", brands);

w("ai.json",
  ai
    ? {
        measured_at: ai.measured_at || null,
        prompts: ai.prompts || [],
        claude: ai.claude || { status: "not_measured" },
        web: ai.web || { status: "not_connected" },
        other_models: ai.other_models || {},
        audit: ai.audit || null,
      }
    : {
        status: "not_measured",
        reason:
          "AI answer visibility has not been measured yet. Run /refresh-intel in Claude Code " +
          "(or: node collectors/claude/ai-visibility.js build).",
        prompts: [],
        claude: { status: "not_measured" },
        web: { status: "not_connected" },
        other_models: {},
      }
);

w("recommendations.json",
  recs || {
    status: "not_generated",
    reason:
      "Recommendations have not been generated yet. Run /refresh-intel in Claude Code " +
      "(or: node collectors/claude/recommend.js build).",
    recommendations: [],
  }
);

// Everything excluded, with the reason, so nothing disappears silently.
w("audit.json", {
  built_at: now.toISOString(),
  excluded_unverified: unverified.map(r => ({
    brand: r.brand_id,
    channel: r.channel,
    url: r.url,
    reason: rejectionReason(r),
    http_status: r.http_status,
    source: r.source_adapter,
  })),
  legacy_reverification: legacyRejected
    ? {
        submitted: legacyRejected.submitted,
        passed: legacyRejected.passed,
        rejected: legacyRejected.rejected,
        note: legacyRejected.note,
        rejections: legacyRejected.rejections,
      }
    : null,
  collector_run: coverage
    ? {
        finished_at: coverage.finished_at,
        window_days: coverage.window_days,
        adapters: coverage.adapters,
        verification: coverage.verification,
        gaps: coverage.gaps,
        rejection_total: coverage.rejection_total,
        rejections_sample: (coverage.rejections || []).slice(0, 100),
      }
    : null,
});

/* ---------------------------------------------------------------- report */

console.log(`\nBuilt from ${totals.total} verified records (${unverified.length} excluded)`);
console.log(`  exact dates: ${totals.dated}   undated: ${totals.undated}   links OK: ${totals.link_ok}/${totals.total}`);
console.log(`  sentiment classified: ${classified}/${totals.total}`);
console.log(`\n  brand           ` + CHANNEL_IDS.map(c => c.padStart(9)).join("") + "     total");
for (const id of brandOrder()) {
  const s = brands[id].stats;
  console.log(
    "  " + brand(id).name.padEnd(15) +
      CHANNEL_IDS.map(c => String(s.by_channel[c] || 0).padStart(9)).join("") +
      String(s.total).padStart(10)
  );
}
console.log(`\n  range totals (dated records only):`);
for (const d of RANGES) console.log(`    ${String(d).padStart(4)}d: ${totals.ranges[d].total}`);
const cav = buildCaveats();
if (cav.dormant.length) {
  console.log(`\n  dormant sources: ${cav.dormant.map(d => d.adapter).join(", ")}`);
}
console.log("");
