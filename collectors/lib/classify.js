/**
 * Deterministic mention classification: type, buying intent, competitor
 * comparisons, event/sponsorship flag, channel mapping.
 *
 * WHY DETERMINISTIC AND NOT AN LLM
 * --------------------------------
 * Every value here is derived from patterns matched against text we actually
 * fetched, so each carries the matched phrase as evidence and is reproducible.
 * That keeps `verification_status` honest: these are "rule-derived", auditable
 * without a model in the loop. Where a provider supplies its own label (Octolens
 * ships sentiment, relevance and tags), that label is preserved and attributed to
 * the provider rather than recomputed — so the dashboard can always say which
 * system made a given call.
 *
 * Claude still classifies SENTIMENT for records no provider labelled, via the
 * grounded-quote queue. Nothing in this file guesses sentiment.
 */

/* ------------------------------------------------------------- channels */

/**
 * Source → channel, per the tracking spec. Anything unrecognised becomes "web"
 * rather than being dropped or guessed into a social channel.
 */
const SOURCE_CHANNEL = {
  linkedin: "linkedin",
  twitter: "x",
  x: "x",
  youtube: "youtube",
  instagram: "instagram",
  facebook: "facebook",
  // Reddit / GitHub / HN / forums / podcasts / general sites all read as "web".
  reddit: "web",
  github: "web",
  hackernews: "web",
  "hacker news": "web",
  hn: "web",
  dev: "web",
  stackoverflow: "web",
  "stack overflow": "web",
  bluesky: "web",
  tiktok: "youtube",     // short-form video; no separate TikTok channel in the UI
  podcast: "web",
  podcasts: "web",
  newsletter: "blog",
  news: "blog",
  rss: "blog",
  blog: "blog",
  web: "web",
};

/**
 * The URL's own host, where it identifies a platform unambiguously.
 *
 * This is checked BEFORE the source mapping, which is a correction: the source
 * is the adapter that found the item, and a discovery adapter finds items on
 * every platform. Measured — 8 youtube.com/watch URLs discovered by the SearXNG
 * adapter were filed under "Web" because `SOURCE_CHANNEL.searxng` won, so a
 * YouTube video did not appear under the YouTube filter. The domain is the
 * stronger signal, exactly as the previous comment here already claimed.
 */
function channelFromUrl(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (/(^|\.)linkedin\.com$|(^|\.)lnkd\.in$/.test(h)) return "linkedin";
    if (/(^|\.)(x|twitter)\.com$/.test(h)) return "x";
    if (/(^|\.)(youtube\.com|youtu\.be)$/.test(h)) return "youtube";
    if (/(^|\.)instagram\.com$/.test(h)) return "instagram";
    if (/(^|\.)(facebook\.com|fb\.com|fb\.watch)$/.test(h)) return "facebook";
  } catch (e) { /* no usable url */ }
  return null;
}

function channelFromSource(source, url) {
  // Platform domains are decisive and take precedence over the finding adapter.
  const fromUrl = channelFromUrl(url);
  if (fromUrl) return fromUrl;

  const s = String(source || "").toLowerCase().trim();
  if (SOURCE_CHANNEL[s]) return SOURCE_CHANNEL[s];

  return "web";
}

/* --------------------------------------------------------- mention types */

/**
 * Ordered most-specific first: the first match wins, so "Document360 vs
 * Mintlify" is a comparison rather than a generic brand mention.
 * Every entry records the phrase that matched, so a type is always explainable.
 */
const TYPE_RULES = [
  ["comparison",        /\b(vs\.?|versus)\b|\bcompared? (?:to|with)\b|\bhead[- ]to[- ]head\b/i],
  ["alternative_request", /\balternatives?\b|\breplacement for\b|\bswitch(?:ing)? (?:from|away from)\b|\bmigrat(?:e|ing) (?:from|off)\b/i],
  ["buying_intent",     /\b(?:looking for|searching for|need|recommend(?:ations?)? for|which|what'?s the best|any suggestions)\b[^.?!]{0,60}\b(?:documentation|knowledge base|kb|docs|wiki|help ?cent(?:er|re))\b/i],
  ["complaint",         /\b(?:frustrat\w+|annoying|broken|terrible|awful|useless|waste of money|too expensive|hate)\b/i],
  ["bug_report",        /\b(?:bug|crash(?:es|ed|ing)?|error|not working|broken build|regression)\b/i],
  ["pricing",           /\bpric(?:e|ing)\b|\bcost(?:s|ing)?\b|\bper seat\b|\bquote\b|\bplans?\b.{0,20}\b(?:tier|month|annual)\b/i],
  ["migration",         /\bmigrat\w+\b|\bimport(?:ing)? (?:from|our)\b|\bmoved? (?:from|off)\b/i],
  ["partnership",       /\bpartner(?:ship|ing)?\b|\bintegrat(?:ion|es? with)\b|\bcollaborat\w+ with\b/i],
  ["announcement",      /\b(?:announc\w+|launch(?:es|ed|ing)?|introduc(?:es|ing)|now available|released?|ships?|shipping)\b/i],
  ["sponsorship",       /\bsponsor(?:s|ed|ing|ship)?\b|\bexhibitor\b|\bbooth\b|\btitle sponsor\b/i],
  ["event",             /\bconference\b|\bsummit\b|\bwebinar\b|\bmeetup\b|\bkeynote\b|\bexpo\b|\bworkshop\b/i],
  ["case_study",        /\bcase stud(?:y|ies)\b|\bsuccess story\b|\bhow .{0,30} uses?\b/i],
  ["tutorial",          /\b(?:tutorial|how[- ]to|step[- ]by[- ]step|guide to|walkthrough|getting started)\b/i],
  ["review",            /\breview(?:s|ed|ing)?\b|\bhands[- ]on\b|\bmy experience with\b|\bpros and cons\b/i],
  ["feature_discussion",/\bfeature(?:s)?\b|\bapi\b|\bworkflow\b|\bversioning\b|\bsearch\b|\bpermissions?\b/i],
  ["recommendation",    /\b(?:i recommend|we recommend|would recommend|go with|check out|worth (?:a look|trying))\b/i],
  ["customer_feedback", /\b(?:we (?:use|switched|adopted)|our team uses|been using)\b/i],
];

function classifyType(text, providerTags) {
  const t = String(text || "");

  // Provider tags are authoritative when present — Octolens assigns these from
  // its own model and we should not overwrite another system's judgement.
  const tags = (providerTags || []).map(x => String(x).toLowerCase());
  const fromProvider = {
    buy_intent: "buying_intent",
    competitor_mention: "comparison",
    user_feedback: "customer_feedback",
    bug_report: "bug_report",
    product_question: "feature_discussion",
    promotional_post: "announcement",
    industry_insights: "feature_discussion",
    own_brand_mention: "brand_mention",
    event: "event",
    feature_request: "feature_discussion",
  };
  for (const tag of tags) {
    if (fromProvider[tag]) {
      return { type: fromProvider[tag], matched: `provider tag: ${tag}`, by: "provider" };
    }
  }

  for (const [type, re] of TYPE_RULES) {
    const m = t.match(re);
    if (m) return { type, matched: m[0].slice(0, 60), by: "rule" };
  }
  return { type: "brand_mention", matched: null, by: "default" };
}

/* --------------------------------------------------------- buying intent */

const INTENT_RULES = [
  /\bbest\b[^.?!]{0,40}\b(?:documentation|knowledge base|kb|docs|help ?cent(?:er|re)|wiki)\b[^.?!]{0,20}\b(?:platform|tool|software|solution)?/i,
  /\blooking for\b[^.?!]{0,60}\b(?:alternative|documentation|knowledge base|docs tool)\b/i,
  /\bwhich\b[^.?!]{0,40}\b(?:knowledge base|documentation|docs)\b[^.?!]{0,30}\b(?:should|do you|would you|recommend)\b/i,
  /\b(?:evaluating|shortlist(?:ing)?|comparing|trialing|considering)\b[^.?!]{0,50}\b(?:documentation|knowledge base|docs)\b/i,
  /\b(?:we(?:'re| are) (?:choosing|picking|deciding)|help me (?:choose|pick))\b/i,
];

function detectBuyingIntent(text, providerTags) {
  const tags = (providerTags || []).map(x => String(x).toLowerCase());
  if (tags.includes("buy_intent")) {
    return { intent: true, matched: "provider tag: buy_intent", by: "provider" };
  }
  const t = String(text || "");
  for (const re of INTENT_RULES) {
    const m = t.match(re);
    if (m) return { intent: true, matched: m[0].slice(0, 80), by: "rule" };
  }
  return { intent: false, matched: null, by: "rule" };
}

/* ----------------------------------------------------- comparison targets */

/**
 * Which OTHER tracked products appear alongside this one. Uses the same
 * disambiguating matcher as everything else, so "a confluence of factors" never
 * becomes a competitor comparison.
 */
function detectComparisons(text, ownBrandId) {
  const { brandOrder, matchBrand, brand } = require("./brands");
  const out = [];
  for (const id of brandOrder()) {
    if (id === ownBrandId) continue;
    const m = matchBrand(text, id);
    if (m.present) out.push({ id, name: brand(id).name, matched_alias: m.matched_alias });
  }
  return out;
}

/* ---------------------------------------------------------- event / sponsor */

const SPONSOR_RE = /\bsponsor(?:s|ed|ing|ship)?\b|\bexhibitor\b|\bbooth\b|\b(?:title|platinum|gold|silver|bronze|presenting|diamond) sponsor\b/i;
const EVENT_RE = /\bconference\b|\bsummit\b|\bwebinar\b|\bmeetup\b|\bkeynote\b|\bexpo\b|\btrade ?show\b|\bworkshop\b/i;

function detectEvent(text, providerTags) {
  const tags = (providerTags || []).map(x => String(x).toLowerCase());
  const t = String(text || "");
  const sponsor = SPONSOR_RE.exec(t);
  const event = EVENT_RE.exec(t);
  const providerEvent = tags.includes("event");
  return {
    is_event: !!(event || providerEvent),
    is_sponsorship: !!sponsor,
    matched: sponsor ? sponsor[0] : event ? event[0] : providerEvent ? "provider tag: event" : null,
  };
}

/* ------------------------------------------------------------- sentiment */

/**
 * Normalise a provider's sentiment label. Returns null when the provider gave
 * none — never a guess. A null sentiment stays "unclassified" until Claude
 * classifies it against the evidence excerpt.
 */
function normaliseSentiment(v) {
  const s = String(v || "").toLowerCase().trim();
  if (["positive", "pos"].includes(s)) return "positive";
  if (["negative", "neg"].includes(s)) return "negative";
  if (["neutral", "neu", "mixed"].includes(s)) return "neutral";
  return null;
}

/**
 * Relevance → 0..1. Octolens returns a word ("relevant"/"irrelevant") plus a
 * numeric relevanceScore that is frequently 0, so the word is the usable signal.
 */
function normaliseRelevance(word, score) {
  const w = String(word || "").toLowerCase().trim();
  if (typeof score === "number" && score > 0) return Math.max(0, Math.min(1, score > 1 ? score / 100 : score));
  if (w === "relevant") return 0.8;
  if (w === "irrelevant") return 0.1;
  if (w === "maybe" || w === "uncertain") return 0.5;
  return null;
}

module.exports = {
  channelFromSource,
  channelFromUrl,
  classifyType,
  detectBuyingIntent,
  detectComparisons,
  detectEvent,
  normaliseSentiment,
  normaliseRelevance,
  SOURCE_CHANNEL,
};
