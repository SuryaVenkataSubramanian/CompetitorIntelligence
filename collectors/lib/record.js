/**
 * The Mention record — the single source of truth for what counts as usable data.
 *
 * A record is only VERIFIED (and therefore only countable in a business metric)
 * when all of the following hold:
 *
 *   - mention_confirmed: a brand alias literally appears in fetched text
 *   - evidence:          a verbatim excerpt was extracted from that text
 *   - url_verified OR source_verified:
 *       url_verified    = we fetched the item URL itself and got 2xx
 *       source_verified = we fetched an authoritative first-party feed/API
 *                         (the brand's own blog feed, its YouTube channel feed)
 *                         that published this item
 *
 * Both are genuine provenance, and they are tracked separately because they
 * answer different questions: source_verified means "this item really was
 * published"; url_verified means "the hyperlink in the dashboard actually works".
 * The UI surfaces link health from url_verified specifically, so a dead link is
 * visible rather than shipped to a business user as a working reference.
 *
 * Everything else is retained but marked, and excluded from metrics. This is why
 * the dashboard cannot show a hallucinated number: the aggregation layer only
 * ever counts records whose provenance chain is complete.
 *
 * Sentiment is deliberately NOT part of verification. It is a judgement, so it
 * carries its own provenance (`sentiment_method`) and is null until Claude
 * classifies it against the evidence excerpt. A null sentiment renders as
 * "unclassified" — never as neutral, because those mean different things.
 */

/**
 * The tracked channels. Grouped so the dashboard can show "socials" as one
 * number and still break it down, which is how a board audience reads it.
 */
const CHANNELS = {
  linkedin: { id: "linkedin", label: "LinkedIn", order: 1, group: "social" },
  x: { id: "x", label: "X", order: 2, group: "social" },
  youtube: { id: "youtube", label: "YouTube", order: 3, group: "social" },
  instagram: { id: "instagram", label: "Instagram", order: 4, group: "social" },
  facebook: { id: "facebook", label: "Facebook", order: 5, group: "social" },
  blog: { id: "blog", label: "Blogs", order: 6, group: "editorial" },
  web: { id: "web", label: "Web", order: 7, group: "editorial" },
  event: { id: "event", label: "Events & Sponsorships", order: 8, group: "events" },
};

const CHANNEL_GROUPS = {
  social: { id: "social", label: "Social", channels: ["linkedin", "x", "youtube", "instagram", "facebook"] },
  editorial: { id: "editorial", label: "Blogs & Web", channels: ["blog", "web"] },
  events: { id: "events", label: "Events & Sponsorships", channels: ["event"] },
};

/**
 * `video` was the old id for YouTube. Kept as an alias so existing store records
 * keep working instead of silently vanishing from every count on rename.
 */
const CHANNEL_ALIASES = { video: "youtube" };

function normaliseChannel(ch) {
  return CHANNEL_ALIASES[ch] || ch;
}

const CHANNEL_IDS = Object.keys(CHANNELS);
const SENTIMENTS = ["positive", "negative", "neutral"];
const DATE_CONFIDENCE = ["exact", "unknown"];

/**
 * Build a record. Callers pass only what they actually observed; this function
 * refuses to invent defaults for anything factual.
 */
function makeRecord(input) {
  const {
    brand_id,
    channel,
    url,
    canonical_url,
    domain,
    title,
    published_at = null,
    date_method = null,
    evidence = null,
    evidence_source = null,
    source_adapter,
    discovered_via = null,
    author = null,
    // provenance receipt fields
    http_status = null,
    fetched_at = null,
    content_sha256 = null,
    url_verified = false,
    source_verified = false,
    verification_method = null, // "page" | "feed" | "api"
    mention_confirmed = false,
    matched_alias = null,
    match_context_term = null,
    occurrences = 0,
    // judgement fields — null until classified
    sentiment = null,
    sentiment_method = null,
    sentiment_rationale = null,

    /* ---- API-provider fields (Octolens / NewsAPI / etc.) ----
     * These describe WHERE a value came from as much as what it is. A score or
     * label supplied by a provider is attributed to that provider and never
     * silently merged with a rule-derived or Claude-derived one, so the dashboard
     * can always state which system made a given call.
     */
    api_source = null,           // "octolens" | "newsapi" | "searxng" | "blogfeed" | …
    relevance_score = null,      // 0..1, provider-supplied where available
    relevance_comment = null,    // provider's own explanation, verbatim
    confidence_score = null,     // 0..1, how sure we are of PRODUCT resolution
    mention_type = null,         // see lib/classify.js TYPE_RULES
    mention_type_basis = null,   // the phrase or provider tag that produced it
    buying_intent = false,
    buying_intent_basis = null,
    comparison_products = [],    // other tracked products named alongside
    is_event = false,
    is_sponsorship = false,
    event_basis = null,
    engagement = null,           // { followers, likes, reposts, replies, … } as observed
    provider_tags = [],          // provider's own labels, kept verbatim

    // channel-specific extras, all optional and only set when observed
    extra = {},
  } = input;

  if (!brand_id) throw new Error("record requires brand_id");
  const ch = normaliseChannel(channel);
  if (!CHANNEL_IDS.includes(ch)) throw new Error("record has invalid channel: " + channel);
  if (!source_adapter) throw new Error("record requires source_adapter for provenance");

  return {
    brand_id,
    channel: ch,
    url,
    canonical_url: canonical_url || url,
    domain: domain || null,
    title: title || null,
    author,

    // dates: only ever "exact" or "unknown". There is no inferred bucket,
    // because an inferred date is not a fact and must not drive a date filter.
    published_at: published_at || null,
    date_confidence: published_at ? "exact" : "unknown",
    date_method: published_at ? date_method : null,

    // evidence for the mention itself
    evidence,
    evidence_source,

    // provenance
    source_adapter,
    discovered_via,
    http_status,
    fetched_at,
    content_sha256,
    url_verified: !!url_verified,
    source_verified: !!source_verified,
    verification_method,
    mention_confirmed: !!mention_confirmed,
    matched_alias,
    match_context_term,
    occurrences,

    // judgement
    sentiment: SENTIMENTS.includes(sentiment) ? sentiment : null,
    sentiment_method,
    sentiment_rationale,

    // provider + classification
    api_source: api_source || source_adapter,
    relevance_score: typeof relevance_score === "number" ? relevance_score : null,
    relevance_comment: relevance_comment || null,
    confidence_score: typeof confidence_score === "number" ? confidence_score : null,
    mention_type: mention_type || null,
    mention_type_basis: mention_type_basis || null,
    buying_intent: !!buying_intent,
    buying_intent_basis: buying_intent_basis || null,
    comparison_products: Array.isArray(comparison_products) ? comparison_products : [],
    is_event: !!is_event,
    is_sponsorship: !!is_sponsorship,
    event_basis: event_basis || null,
    engagement: engagement || null,
    provider_tags: Array.isArray(provider_tags) ? provider_tags : [],

    extra: extra || {},
  };
}

/**
 * How a record's fields were established, for the Data Quality panel and the
 * per-row badge. Three distinct grades — conflating them is what lets a guess
 * pass as a measurement:
 *
 *   verified     - URL fetched 2xx AND brand confirmed in the fetched text
 *   provider     - supplied by an API (Octolens/NewsAPI) but the URL was not
 *                  independently re-fetched by us
 *   ai_classified - the value came from a model (currently only sentiment)
 */
function verificationStatus(r) {
  if (!r) return "unknown";
  const fetched = r.url_verified && r.mention_confirmed && r.evidence;
  if (fetched) return "verified";
  if (r.source_verified && r.mention_confirmed) return "provider";
  return "unverified";
}

/** A record is verified only when the whole provenance chain is intact. */
function isVerified(r) {
  return !!(r && (r.url_verified || r.source_verified) && r.mention_confirmed && r.evidence);
}

/** Is the hyperlink shown in the dashboard actually known to work? */
function isLinkHealthy(r) {
  return !!(r && r.url_verified);
}

/** Verified AND has a real date — the only records a date range may filter on. */
function isDateUsable(r) {
  return isVerified(r) && r.date_confidence === "exact" && !!r.published_at;
}

/**
 * Explain in one phrase why a record is not verified. Shown in the audit view
 * so rejected rows are inspectable rather than silently vanishing.
 */
function rejectionReason(r) {
  if (!r) return "empty record";
  if (!r.url_verified && !r.source_verified) {
    return r.http_status ? `URL returned HTTP ${r.http_status}` : "URL could not be fetched";
  }
  if (!r.mention_confirmed) {
    return r.match_rejected_reason || "brand name not found in fetched text";
  }
  if (!r.evidence) return "no verbatim excerpt could be extracted";
  return null;
}

/** Stable key for cross-run dedupe. */
function recordKey(r) {
  return `${r.brand_id}::${r.channel}::${r.canonical_url}`;
}

/**
 * Merge a newly collected record over a stored one, preserving the stored
 * Claude classification unless the underlying page content changed.
 * This stops a re-run from wiping human/LLM-reviewed sentiment for free.
 */
function mergeRecord(stored, fresh) {
  if (!stored) return fresh;

  // Invalidate a stored classification only when the text Claude actually judged
  // has changed — i.e. the evidence excerpt. Comparing raw HTML hashes instead
  // would discard a valid classification every time an ad slot, CSRF token or
  // "published X days ago" string shifted, causing endless re-classification of
  // pages whose meaning never moved.
  const normEv = s => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const contentChanged = normEv(stored.evidence) !== normEv(fresh.evidence);

  return {
    ...fresh,
    // Keep the first time we ever saw it.
    first_seen: stored.first_seen || stored.fetched_at || fresh.fetched_at,
    // Preserve classification when the page text is unchanged.
    sentiment: contentChanged ? fresh.sentiment : (fresh.sentiment ?? stored.sentiment),
    sentiment_method: contentChanged
      ? fresh.sentiment_method
      : (fresh.sentiment_method ?? stored.sentiment_method),
    sentiment_rationale: contentChanged
      ? fresh.sentiment_rationale
      : (fresh.sentiment_rationale ?? stored.sentiment_rationale),
    // Never lose a real date we already proved.
    published_at: fresh.published_at || stored.published_at || null,
    date_confidence: (fresh.published_at || stored.published_at) ? "exact" : "unknown",
    date_method: fresh.published_at ? fresh.date_method : (stored.date_method || null),
    // Carry the quote forward with its classification, so the UI can still show
    // what the sentiment was judged from after a re-run.
    sentiment_quote: contentChanged ? fresh.sentiment_quote : (fresh.sentiment_quote ?? stored.sentiment_quote),
    sentiment_at: contentChanged ? fresh.sentiment_at : (fresh.sentiment_at ?? stored.sentiment_at),
    evidence_changed: !!contentChanged,
  };
}

module.exports = {
  CHANNELS,
  CHANNEL_IDS,
  CHANNEL_GROUPS,
  CHANNEL_ALIASES,
  normaliseChannel,
  SENTIMENTS,
  DATE_CONFIDENCE,
  makeRecord,
  isVerified,
  isLinkHealthy,
  verificationStatus,
  isDateUsable,
  rejectionReason,
  recordKey,
  mergeRecord,
};
