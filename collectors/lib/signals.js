/**
 * Grounded signal extraction: sentiment, briefs, priority, and the competitive
 * play a negative mention of a rival opens up.
 *
 * THE LINE THIS FILE DOES NOT CROSS
 * --------------------------------
 * Nothing here invents a fact. Every judgement it returns carries the verbatim
 * span that produced it, and a judgement with no span is not returned at all —
 * it stays unclassified. That is the whole design:
 *
 *   sentiment   requires a matched phrase from a fixed lexicon AND the sentence
 *               it appeared in. No phrase, no sentiment. 1,415 of 1,521 records
 *               are unclassified today; this turns some of them into CLASSIFIED
 *               WITH A QUOTE, and leaves the rest honestly unclassified rather
 *               than guessing neutral.
 *   summary     EXTRACTIVE. Every bullet is a real sentence selected from the
 *               fetched text, trimmed but never rewritten. The dashboard shows
 *               three bullets per mention, and all three are quotes.
 *   priority    computed from measurable things — engagement counts, whether
 *               the text asks for an alternative, whether it names a rival —
 *               never from a vibe.
 *
 * WHAT IS EXPLICITLY A RECOMMENDATION RATHER THAN DATA
 * ---------------------------------------------------
 * `play()` proposes a response and an asset title. That is advice, not an
 * observation, and it is labelled `kind: "recommendation"` so the UI can render
 * it differently from everything above. It is still grounded — the complaint
 * phrase it answers is carried with it — but a reader must never mistake a
 * suggested blog title for something somebody actually published.
 *
 * WHY A LEXICON AND NOT A MODEL
 * -----------------------------
 * A model could classify all 1,415 records. It would also be the only part of
 * this system whose output could not be checked against fetched bytes, and the
 * standing rule here is that accuracy and traceability outrank coverage. The
 * lexicon classifies fewer records and every one of them can be audited by
 * reading the quote. Records the lexicon cannot reach stay unclassified and are
 * DISPLAYED as such — they are not hidden, and they are not counted as neutral.
 */

/* ----------------------------------------------------------------- lexicons */

/**
 * Phrases that state a problem with a product.
 *
 * Weighted, because "is down" is a harder signal than "confusing". Each entry
 * is a regex so word boundaries are explicit — "slow" must not match "slowly
 * but surely improving", which is why the qualifiers are part of the pattern.
 */
const NEGATIVE = [
  { w: 3, re: /\b(?:is|was|are|were)\s+(?:completely\s+|totally\s+)?(?:down|broken|unusable|useless)\b/i, tag: "outage_or_breakage" },
  { w: 3, re: /\b(?:data|content|docs?|articles?)\s+loss\b/i, tag: "data_loss" },
  { w: 3, re: /\b(?:lost|losing)\s+(?:all\s+)?(?:our|my|the)\s+(?:data|docs|content|work)\b/i, tag: "data_loss" },
  { w: 3, re: /\bwe\s+(?:are\s+)?(?:migrat\w+|moving|switch\w+)\s+(?:away\s+from|off(?:\s+of)?)\b/i, tag: "churn" },
  { w: 3, re: /\b(?:cancel(?:l)?ed|cancelling|canceling)\s+(?:our|my)\s+(?:subscription|plan|account)\b/i, tag: "churn" },
  { w: 3, re: /\bwould\s+not\s+recommend\b/i, tag: "detractor" },
  { w: 3, re: /\b(?:worst|terrible|awful|horrible)\b/i, tag: "detractor" },

  { w: 2, re: /\b(?:too|way too|far too)\s+(?:expensive|pricey|costly)\b/i, tag: "pricing" },
  { w: 2, re: /\bprice\s+(?:increase|hike|jump)\b/i, tag: "pricing" },
  { w: 2, re: /\b(?:overpriced|not worth the (?:price|money|cost))\b/i, tag: "pricing" },
  { w: 2, re: /\b(?:support|customer service)\s+(?:is|was|has been)\s+(?:slow|poor|bad|terrible|unresponsive|non-?existent)\b/i, tag: "support" },
  { w: 2, re: /\bno\s+(?:response|reply)\s+from\s+support\b/i, tag: "support" },
  { w: 2, re: /\b(?:constant|frequent|repeated)\s+(?:outages?|downtime|bugs?|errors?)\b/i, tag: "reliability" },
  { w: 2, re: /\b(?:keeps?|kept)\s+(?:crashing|breaking|failing|timing out)\b/i, tag: "reliability" },
  { w: 2, re: /\bcan(?:no|')?t\s+(?:export|import|migrate|search|find)\b/i, tag: "missing_capability" },
  { w: 2, re: /\b(?:lacks?|lacking|missing|no)\s+(?:support for|the ability to|a way to)\b/i, tag: "missing_capability" },
  /* ASKING for an alternative is a complaint. LISTING alternatives is not.
   *
   * MEASURED: a bare /alternatives? to/ matched "A curated collection of the 4
   * best open source alternatives to Mintlify" and "Open Source Alternatives to
   * Gitbook" — editorial round-ups, not dissatisfied users. They were filed as
   * negative mentions, which would send somebody to reply to a listicle. Only
   * the first-person and question forms stay here; round-ups are picked up as a
   * separate competitive-listing signal that carries no sentiment. */
  { w: 2, re: /\b(?:looking|searching)\s+for\s+(?:an?\s+)?alternatives?\s+to\b/i, tag: "asking_for_alternative" },
  { w: 2, re: /\b(?:any(?:one|body))\s+(?:know|have|used|tried|recommend)\b[^.]{0,40}\balternatives?\b/i, tag: "asking_for_alternative" },
  { w: 2, re: /\b(?:we|I)\s+(?:need|want|am\s+looking\s+for)\s+(?:an?\s+)?alternatives?\s+to\b/i, tag: "asking_for_alternative" },

  { w: 1, re: /\b(?:confusing|clunky|cumbersome|painful|frustrating|frustrated)\b/i, tag: "usability" },
  { w: 1, re: /\b(?:steep|hard)\s+learning\s+curve\b/i, tag: "usability" },
  { w: 1, re: /\bhard\s+to\s+(?:use|navigate|configure|set ?up)\b/i, tag: "usability" },
  { w: 1, re: /\b(?:slow|sluggish|laggy)\s+(?:editor|search|interface|ui|loading|performance)\b/i, tag: "performance" },
  { w: 1, re: /\b(?:disappoint(?:ed|ing)|regret|wish (?:it|they) (?:did|had|would))\b/i, tag: "dissatisfaction" },
  { w: 1, re: /\b(?:bug|broken link|error message)s?\b.{0,40}\b(?:still|again|never fixed)\b/i, tag: "reliability" },
];

/** Phrases that state approval. Same rules: weighted, bounded, quotable. */
const POSITIVE = [
  { w: 3, re: /\b(?:we|I)\s+(?:switched|moved|migrated)\s+to\b/i, tag: "won_deal" },
  { w: 3, re: /\b(?:highly\s+recommend|would\s+recommend|can'?t\s+recommend\s+\w+\s+enough)\b/i, tag: "advocacy" },
  { w: 3, re: /\bbest\s+(?:documentation|knowledge ?base|docs|help ?center)\s+(?:tool|platform|software)\b/i, tag: "advocacy" },
  { w: 2, re: /\b(?:love|loving|really like|big fan of)\b/i, tag: "advocacy" },
  { w: 2, re: /\b(?:excellent|outstanding|fantastic|superb)\s+(?:support|documentation|experience|product)\b/i, tag: "praise" },
  { w: 2, re: /\b(?:saved|cut)\s+us\s+\w+\s+(?:hours|days|weeks|time)\b/i, tag: "roi" },
  { w: 2, re: /\b(?:easy|simple|straightforward)\s+to\s+(?:use|set ?up|configure|migrate)\b/i, tag: "usability" },
  { w: 1, re: /\b(?:great|solid|impressive|smooth)\b/i, tag: "praise" },
  { w: 1, re: /\b(?:works?\s+(?:really\s+)?well|does exactly what)\b/i, tag: "praise" },
];

/** Buying-intent phrases: someone is actively choosing. */
const INTENT = [
  { re: /\b(?:evaluat\w+|comparing|shortlist\w*|considering)\b/i, tag: "evaluating" },
  { re: /\b(?:vs\.?|versus)\b/i, tag: "comparison" },
  { re: /\b(?:which|what)\s+(?:one|tool|platform|should)\b/i, tag: "asking_advice" },
  { re: /\b(?:recommend(?:ations?)?\s+for|looking\s+for\s+a)\b/i, tag: "asking_advice" },
  { re: /\b(?:free\s+trial|demo|pricing|quote)\b/i, tag: "commercial" },
  /* An editorial round-up. Competitively interesting — someone is ranking the
   * category in public — but nobody is complaining, so it carries no sentiment
   * of its own and must not be counted as a negative mention. */
  { re: /\b(?:top|best|\d+)\s+(?:\w+\s+){0,3}alternatives?\s+to\b/i, tag: "competitive_listicle" },
  { re: /\balternatives?\s+to\b/i, tag: "competitive_listicle" },
];

/* --------------------------------------------------------------- utilities */

function sentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map(s => s.trim())
    .filter(s => s.length >= 25 && s.length <= 400);
}

/** The sentence containing a match, or a bounded window if none parses out. */
function sentenceAround(text, index, matchLen) {
  const t = String(text || "").replace(/\s+/g, " ");
  const start = Math.max(0, t.lastIndexOf(".", index) + 1);
  const nextStop = t.indexOf(".", index + matchLen);
  const end = nextStop === -1 ? Math.min(t.length, index + matchLen + 160) : nextStop + 1;
  const s = t.slice(start, end).trim();
  if (s.length >= 20) return s;
  return t.slice(Math.max(0, index - 90), Math.min(t.length, index + matchLen + 90)).trim();
}

function aliasRegex(alias) {
  if (!alias) return null;
  return new RegExp(
    "(^|[^A-Za-z0-9])" + String(alias).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+") + "([^A-Za-z0-9]|$)",
    "i"
  );
}

/**
 * Lexicon hits, each ANCHORED or not.
 *
 * Anchoring is the fix for a real misclassification. A Mintlify testimonial read
 *
 *   "...it was becoming horrible to keep them all in sync when changes happened.
 *    Now I'm using a @mintlify workflow that propagates the changes
 *    automatically. I love this feature so much."
 *
 * The lexicon scored "horrible" (weight 3) over "love" (weight 2) and called a
 * five-star testimonial a NEGATIVE mention of Mintlify. It is not: "horrible"
 * describes the problem Mintlify SOLVED. That pattern — a painful before-state
 * followed by the product as the cure — is how most positive testimonials are
 * written, so this is not an edge case, it is the dominant shape.
 *
 * A phrase is therefore only evidence about a brand if the brand is named in the
 * SAME SENTENCE. Anything else is context about the writer's situation.
 */
/**
 * Language that turns a complaint into its opposite.
 *
 * MEASURED: "Mintlify centralized secrets while the lift was small, sidestepping
 * the PAINFUL migration" was classified as a usability complaint about Mintlify.
 * The alias is in the same sentence, so anchoring did not catch it — the
 * negative word describes what the product AVOIDED. Marketing copy is built on
 * that shape, so it is not a rare case.
 *
 * Checked in the ~70 characters before the match, which is where the avoidance
 * verb actually sits.
 */
const AVOIDANCE = /\b(?:avoid(?:s|ed|ing)?|sidestep(?:s|ped|ping)?|without|no more|instead of|rather than|prevent(?:s|ed|ing)?|eliminat(?:e|es|ed|ing)|sav(?:e|es|ed|ing)\s+(?:you|us|them|me)\s+from|free\s+from|used\s+to\s+be|was\s+becoming|no\s+longer)\b[^.]{0,60}$/i;

function hits(text, lexicon, aliasRe) {
  const out = [];
  const t = String(text || "");
  for (const entry of lexicon) {
    const m = entry.re.exec(t);
    if (!m) continue;
    // A negative word inside an avoidance clause is praise, not a complaint.
    if (AVOIDANCE.test(t.slice(Math.max(0, m.index - 70), m.index))) continue;
    const quote = sentenceAround(t, m.index, m[0].length);
    out.push({
      tag: entry.tag,
      weight: entry.w == null ? 1 : entry.w,
      matched: m[0].trim(),
      quote,
      anchored: aliasRe ? aliasRe.test(quote) : null,
    });
  }
  return out;
}

/* ------------------------------------------------------------- sentiment */

/**
 * Classify sentiment, or decline to.
 *
 * Returns null when no lexicon phrase is present. That is the common case and
 * it is the correct answer: "we could not tell" is information, and recording
 * it as neutral would be a fabrication that silently moves a percentage.
 *
 * Mixed text ("great editor but support is terrible") resolves to whichever
 * side carries more weight, and BOTH sides are returned so the reader sees the
 * mix rather than only the verdict.
 */
function classifySentiment(text, { alias = null } = {}) {
  const aliasRe = aliasRegex(alias);
  let neg = hits(text, NEGATIVE, aliasRe);
  let pos = hits(text, POSITIVE, aliasRe);
  if (!neg.length && !pos.length) return null;

  /* With an alias in hand, only sentences that NAME THE BRAND can speak for it.
   * If nothing is anchored, the honest answer is that we cannot attribute the
   * sentiment — not that it is neutral. See hits() for the testimonial that
   * made this necessary. */
  if (aliasRe) {
    const na = neg.filter(h => h.anchored);
    const pa = pos.filter(h => h.anchored);
    if (!na.length && !pa.length) return null;
    neg = na;
    pos = pa;
  }

  const negScore = neg.reduce((a, h) => a + h.weight, 0);
  const posScore = pos.reduce((a, h) => a + h.weight, 0);

  let sentiment;
  if (negScore > posScore) sentiment = "negative";
  else if (posScore > negScore) sentiment = "positive";
  else sentiment = "neutral";   // genuinely balanced, with quotes on both sides

  const lead = sentiment === "negative"
    ? neg.slice().sort((a, b) => b.weight - a.weight)[0]
    : sentiment === "positive"
      ? pos.slice().sort((a, b) => b.weight - a.weight)[0]
      : (neg[0] || pos[0]);

  // Strength of the evidence, not a probability. One weak phrase is 0.5; a
  // strong phrase with corroboration is high. Deliberately capped below 1.0 —
  // a lexicon is never certain.
  const top = Math.max(negScore, posScore);
  const confidence = Math.min(0.92, 0.4 + top * 0.12 + (neg.length + pos.length - 1) * 0.05);

  return {
    sentiment,
    grade: "lexicon",
    method: "Matched a fixed phrase lexicon against the fetched text, counting only phrases in a sentence that names the brand. The matched phrase and its sentence are both recorded, so this judgement can be audited by reading the quote.",
    confidence: Number(confidence.toFixed(2)),
    trigger: lead ? { phrase: lead.matched, quote: lead.quote, tag: lead.tag } : null,
    negative_hits: neg.map(h => ({ tag: h.tag, phrase: h.matched, quote: h.quote })),
    positive_hits: pos.map(h => ({ tag: h.tag, phrase: h.matched, quote: h.quote })),
    themes: [...new Set((negScore >= posScore ? neg : pos).map(h => h.tag))],
  };
}

/** Buying-intent tags present in the text, each with its matched phrase. */
function intentSignals(text) {
  const out = [];
  for (const e of INTENT) {
    const m = e.re.exec(String(text || ""));
    if (m) out.push({ tag: e.tag, phrase: m[0].trim() });
  }
  return out;
}

/* ----------------------------------------------------------------- briefs */

/**
 * Three bullets, every one of them a real sentence from the source.
 *
 * Selection is by score, not by position: the sentence naming the brand, the
 * sentence carrying the strongest lexicon phrase, and the sentence carrying
 * buying intent are the three a reader actually needs. Where the text has fewer
 * than three usable sentences, fewer bullets are returned — padding a summary
 * to a fixed length is exactly how invented content gets in.
 */
function summarise(text, { alias = null, max = 3 } = {}) {
  const ss = sentences(text);
  if (!ss.length) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    return t ? [{ text: t.slice(0, 220), why: "the full text — too short to split into sentences", verbatim: true }] : [];
  }

  const aliasRe = alias
    ? new RegExp("(^|[^A-Za-z0-9])" + alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^A-Za-z0-9]|$)", "i")
    : null;

  const scored = ss.map((s, i) => {
    let score = 0;
    const reasons = [];
    if (aliasRe && aliasRe.test(s)) { score += 5; reasons.push("names the product"); }
    for (const e of NEGATIVE) if (e.re.test(s)) { score += 2 + (e.w || 1); reasons.push("states a problem"); break; }
    for (const e of POSITIVE) if (e.re.test(s)) { score += 2 + (e.w || 1); reasons.push("states approval"); break; }
    for (const e of INTENT) if (e.re.test(s)) { score += 2; reasons.push("shows buying intent"); break; }
    // Numbers and named entities carry more information than adjectives.
    if (/\b\d/.test(s)) score += 1;
    // Earlier sentences are usually the lede.
    score += Math.max(0, 3 - i) * 0.5;
    return { s, score, reasons: [...new Set(reasons)], i };
  });

  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)          // restore reading order
    .map(x => ({
      text: x.s.length > 240 ? x.s.slice(0, 237).trimEnd() + "..." : x.s,
      why: x.reasons.length ? x.reasons.join(", ") : "opening sentence",
      verbatim: true,
    }));
}

/* --------------------------------------------------------------- priority */

/**
 * HIGH / MEDIUM / LOW, from things that can be counted.
 *
 * Each contributing factor is returned, so "why is this HIGH" is answerable
 * from the record rather than from trust.
 */
function priority(record, sentiment) {
  const factors = [];
  let score = 0;
  const x = record.extra || {};

  const eng = Number(x.likes || x.reactions || x.hn_points || x.se_score || 0) +
    Number(x.comments || x.replies || x.github_comments || 0) * 2;
  if (eng >= 50) { score += 3; factors.push("engagement " + eng); }
  else if (eng >= 10) { score += 2; factors.push("engagement " + eng); }
  else if (eng > 0) { score += 1; factors.push("engagement " + eng); }

  if (sentiment && sentiment.sentiment === "negative") {
    const w = sentiment.negative_hits.length;
    score += Math.min(3, w + 1);
    factors.push("negative: " + sentiment.themes.slice(0, 2).join(", "));
  }
  if (sentiment && sentiment.sentiment === "positive") { score += 1; factors.push("positive sentiment"); }

  const intents = intentSignals(record.source_text || "");
  if (intents.some(i => i.tag === "comparison")) { score += 2; factors.push("names a comparison"); }
  if (intents.some(i => i.tag === "evaluating" || i.tag === "asking_advice")) { score += 2; factors.push("actively evaluating"); }
  if (x.signal_type === "asking_for_alternative") { score += 3; factors.push("asking for an alternative"); }
  if (x.signal_type === "reliability_incident") { score += 2; factors.push("vendor incident"); }

  // A named human on a professional network outranks an anonymous forum post.
  if (record.channel === "linkedin" && record.author) { score += 1; factors.push("named author on LinkedIn"); }

  const band = score >= 6 ? "HIGH" : score >= 3 ? "MEDIUM" : "LOW";
  return { band, score, factors };
}

/* ------------------------------------------------------- competitive plays */

/**
 * Given a NEGATIVE mention of a competitor, what Document360 can do about it.
 *
 * THIS IS ADVICE, NOT DATA. It is returned with kind:"recommendation" and the
 * complaint it answers is carried alongside, so the UI can show the quote that
 * prompted it. The theme comes from the lexicon tag that actually fired, so the
 * play always answers the complaint that was made rather than a generic one.
 */
const PLAYS = {
  pricing: {
    angle: "Cost predictability",
    reply: "Acknowledge the cost pressure without naming the competitor, and offer the specific number: what a team of their size pays, and what is included that they are currently buying separately.",
    asset_kind: "comparison page",
    asset_title: n => "What a " + n + " migration actually costs: a line-by-line breakdown",
    proof_needed: "Published per-seat pricing and the list of features included at each tier.",
  },
  support: {
    angle: "Support responsiveness",
    reply: "Reply with a concrete commitment rather than sympathy — name the median first-response time and who answers.",
    asset_kind: "blog post",
    asset_title: () => "Our documented support SLA, and the median first-response time behind it",
    proof_needed: "Real median first-response time from the support desk. Do not publish this without the number.",
  },
  reliability: {
    angle: "Uptime and reliability",
    reply: "Link the public status page and the historical uptime figure. A number beats a reassurance.",
    asset_kind: "trust page",
    asset_title: () => "Uptime, incident history and what happens when something breaks",
    proof_needed: "Verified uptime percentage and a public incident history.",
  },
  outage_or_breakage: {
    angle: "Uptime and reliability",
    reply: "Do not pile on during someone else's outage — it reads badly and gets screenshotted. Publish the reliability asset instead and let search do the work.",
    asset_kind: "trust page",
    asset_title: () => "Uptime, incident history and what happens when something breaks",
    proof_needed: "Verified uptime percentage and a public incident history.",
  },
  data_loss: {
    angle: "Backup, versioning and export",
    reply: "Lead with recovery, not with the competitor's failure: versioning depth, backup cadence, and how a full export works.",
    asset_kind: "technical guide",
    asset_title: () => "Version history, backups and full export: how your content stays yours",
    proof_needed: "Actual retention periods and export formats from the product docs.",
  },
  churn: {
    angle: "Migration",
    reply: "This is an active buying signal. Offer the migration path and a named person, not a trial link.",
    asset_kind: "migration guide",
    asset_title: n => "Migrating from " + n + " to Document360 without breaking your URLs",
    proof_needed: "A real, tested import path and redirect handling for that source platform.",
  },
  missing_capability: {
    angle: "Capability gap",
    reply: "Answer the specific capability they asked for and link the documentation page that proves it exists.",
    asset_kind: "feature deep-dive",
    asset_title: t => "How Document360 handles " + t,
    proof_needed: "A live docs page demonstrating the capability.",
  },
  usability: {
    angle: "Time to first published article",
    reply: "Counter a learning-curve complaint with a measured onboarding time, not with a claim that the product is easy.",
    asset_kind: "video walkthrough",
    asset_title: () => "From empty workspace to a published knowledge base, start to finish",
    proof_needed: "An actual timed walkthrough recording.",
  },
  performance: {
    angle: "Editor and search performance",
    reply: "Publish measured search and editor load times on a realistic corpus size.",
    asset_kind: "benchmark post",
    asset_title: () => "Search performance on a 10,000-article knowledge base, measured",
    proof_needed: "A real benchmark run. Do not publish estimated numbers.",
  },
  asking_for_alternative: {
    angle: "Direct buying intent",
    reply: "Answer the question asked, disclose the affiliation in the first line, and link one page — not the homepage.",
    asset_kind: "alternatives page",
    asset_title: n => "Document360 as a " + n + " alternative: what transfers and what does not",
    proof_needed: "An honest feature comparison, including where the competitor is stronger.",
  },
  detractor: {
    angle: "Reputation",
    reply: "Do not engage with the detractor directly. Build the durable asset that answers the underlying objection.",
    asset_kind: "customer story",
    asset_title: () => "Why teams choose Document360, in their own words",
    proof_needed: "A named, approved customer reference.",
  },
  dissatisfaction: {
    angle: "Unmet expectation",
    reply: "Ask what they expected. The answer is the asset brief, and it costs nothing to ask.",
    asset_kind: "blog post",
    asset_title: () => "The questions to ask before you pick a documentation platform",
    proof_needed: "Nothing beyond product facts.",
  },
};

function play(record, sentiment, competitorName) {
  if (!sentiment || sentiment.sentiment !== "negative") return null;
  const theme = (sentiment.themes && sentiment.themes[0]) || (sentiment.trigger && sentiment.trigger.tag);
  const p = PLAYS[theme];
  if (!p) return null;

  const name = competitorName || "the incumbent";
  const capability = sentiment.trigger ? sentiment.trigger.phrase.replace(/^(?:lacks?|lacking|missing|no)\s+/i, "").trim() : "the gap";

  return {
    kind: "recommendation",
    theme,
    angle: p.angle,
    answers_complaint: sentiment.trigger ? sentiment.trigger.quote : null,
    matched_phrase: sentiment.trigger ? sentiment.trigger.phrase : null,
    channel_reply: record.channel === "linkedin" || record.channel === "x" || record.channel === "web"
      ? p.reply
      : p.reply,
    asset: {
      kind: p.asset_kind,
      title: p.asset_title(theme === "missing_capability" ? capability : name),
      proof_needed: p.proof_needed,
    },
    note: "This is a suggested response, not an observation. The quote above is what prompted it; the asset does not exist until someone builds it.",
  };
}

module.exports = {
  classifySentiment,
  intentSignals,
  summarise,
  priority,
  play,
  sentences,
  NEGATIVE,
  POSITIVE,
  PLAYS,
};
