/**
 * Competitors — Negative Mentions — Opportunities.
 *
 * Two halves, deliberately kept apart because they are different jobs:
 *
 *   1. COMPETITOR NEGATIVES. Every negative mention of a product that is not
 *      ours, with the quote that made it negative, and what Document360 can do
 *      about it — a reply angle for a social post, an asset brief for a web
 *      page that will outlive the thread.
 *
 *   2. OUR OWN MENTIONS. The last N days of Document360 mentions in the digest
 *      shape the team actually reads: priority, channel, author, a three-bullet
 *      extractive summary, and a link.
 *
 * WHAT IS EVIDENCE AND WHAT IS ADVICE
 * -----------------------------------
 * Everything in the `evidence` half of an item — quote, author, date, URL,
 * engagement — was fetched. Everything in the `play` half is a suggestion, and
 * carries kind:"recommendation" so the UI can mark it. A reader must never be
 * able to mistake "here is a blog post we should write" for "here is a blog
 * post that exists". That distinction is the single most important thing this
 * file gets right.
 *
 * WHY NOT SIMPLY RANK BY SENTIMENT SCORE
 * --------------------------------------
 * A negative mention with two likes on a dead forum is not an opportunity; a
 * comparison thread where somebody is actively choosing is. Ranking therefore
 * uses the priority band, which is computed from engagement, buying intent and
 * theme severity — all countable — rather than from how negative the words are.
 */
const signals = require("./signals");

/** Themes worth acting on. A vague grumble is not an opening. */
const ACTIONABLE = new Set([
  "pricing", "support", "reliability", "outage_or_breakage", "data_loss",
  "churn", "missing_capability", "usability", "performance",
  "asking_for_alternative", "detractor", "dissatisfaction",
]);

const BAND_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * Build the payload from built wire records.
 *
 * @param {object} brandsPayload  data/brands.json shape: { [id]: { name, mentions } }
 * @param {string[]} order        brand display order
 * @param {number} days           window for the "our mentions" half
 */
function build(brandsPayload, order, { days = 7, primary = "document360" } = {}) {
  const competitorItems = [];
  const ourItems = [];

  for (const id of order) {
    const b = brandsPayload[id];
    if (!b) continue;

    for (const m of b.mentions || []) {
      const isOurs = id === primary;

      if (!isOurs) {
        // Competitor half: negatives only, and only actionable themes.
        if (m.sentiment !== "negative") continue;
        const theme = (m.themes && m.themes[0]) || null;
        if (theme && !ACTIONABLE.has(theme)) continue;
        // Nothing quotable and no rationale is not an opportunity, it is a
        // verdict with no evidence attached. Those are dropped rather than
        // rendered as an empty card.
        if (!theme && !m.sentiment_quote && !m.sentiment_rationale) continue;

        competitorItems.push({
          id: m.url,
          competitor: id,
          competitor_name: b.name,
          channel: m.channel,
          url: m.url,
          domain: m.domain,
          title: m.title,
          author: m.author,
          date: m.effective_date,
          date_basis: m.date_basis,
          days_ago: m.effective_days_ago,
          priority: m.priority,
          priority_score: m.priority_score,
          priority_factors: m.priority_factors,

          // --- evidence: all of this was fetched ---
          /* Some negatives come from the Claude pass, which recorded a verdict
           * and a rationale but no lexicon theme. Those cards used to render
           * "null" where the complaint belongs. The rationale is what that
           * judgement was actually based on, so it is shown instead — labelled,
           * because a model's rationale is a different kind of evidence from a
           * quoted sentence. */
          theme: theme || "classified_without_theme",
          themes: m.themes || [],
          quote: m.sentiment_quote || null,
          rationale: m.sentiment_rationale || null,
          basis: m.sentiment_quote ? "quote" : (m.sentiment_rationale ? "model rationale" : "none recorded"),
          matched_phrase: m.sentiment_phrase,
          sentiment_grade: m.sentiment_grade,
          sentiment_confidence: m.sentiment_confidence,
          brief: m.brief || [],
          intent_signals: m.intent_signals || [],
          engagement: m.engagement,
          verification_status: m.verification_status,

          // --- advice: none of this was fetched ---
          play: m.play,
        });
        continue;
      }

      // Our half: the recent digest, whatever the sentiment.
      if (m.effective_days_ago == null || m.effective_days_ago > days) continue;
      ourItems.push({
        id: m.url,
        channel: m.channel,
        url: m.url,
        domain: m.domain,
        title: m.title,
        author: m.author,
        date: m.effective_date,
        date_basis: m.date_basis,
        days_ago: m.effective_days_ago,
        hours_ago: m.effective_days_ago != null ? m.effective_days_ago * 24 : null,
        priority: m.priority,
        priority_factors: m.priority_factors,
        sentiment: m.sentiment,
        sentiment_grade: m.sentiment_grade,
        quote: m.sentiment_quote,
        brief: m.brief || [],
        intent_signals: m.intent_signals || [],
        // A "Do:" line only where something concrete prompted it.
        action: ourAction(m),
        verification_status: m.verification_status,
      });
    }
  }

  const sortFn = (a, c) =>
    (BAND_RANK[a.priority] ?? 3) - (BAND_RANK[c.priority] ?? 3) ||
    (c.priority_score || 0) - (a.priority_score || 0) ||
    (a.days_ago ?? 999) - (c.days_ago ?? 999);

  competitorItems.sort(sortFn);
  ourItems.sort(sortFn);

  const byCompetitor = {};
  for (const it of competitorItems) {
    byCompetitor[it.competitor] = (byCompetitor[it.competitor] || 0) + 1;
  }
  const byTheme = {};
  for (const it of competitorItems) {
    if (it.theme) byTheme[it.theme] = (byTheme[it.theme] || 0) + 1;
  }

  return {
    computed_at: new Date().toISOString(),
    window_days: days,
    competitor_negatives: competitorItems,
    our_mentions: ourItems,
    totals: {
      competitor_negatives: competitorItems.length,
      high_priority: competitorItems.filter(i => i.priority === "HIGH").length,
      our_mentions_in_window: ourItems.length,
      by_competitor: byCompetitor,
      by_theme: byTheme,
    },
    method:
      "Negative mentions are those where a lexicon phrase matched inside a sentence that names the " +
      "product. The matched phrase and its sentence are shown on every card, so each call can be " +
      "checked by reading the quote. Suggested replies and asset titles are recommendations, not " +
      "observations, and are labelled as such.",
    coverage_note:
      "This shows what the connected sources actually returned. A competitor with no negatives here " +
      "has none that our sources surfaced and classified — it is not a claim that none exist.",
  };
}

/**
 * The "Do:" line for one of our own mentions.
 *
 * Returned only where the text contains something specific to act on. A generic
 * "engage with this post" on every card would be noise, and noise is what makes
 * a digest stop being read.
 */
function ourAction(m) {
  const x = m.extra || {};
  const text = m.evidence || "";

  // A shortened link in a post about us is worth checking before it spreads.
  const short = /\b(?:bit\.ly|tinyurl\.com|lnkd\.in|t\.co|linktr\.ee|rb\.gy|ow\.ly)\/\S+/i.exec(text);
  if (short) {
    return {
      text: "Check whether " + short[0] + " is an approved partner link before this spreads further.",
      basis: "a shortened link appears in the text",
    };
  }
  if (m.sentiment === "negative") {
    return {
      text: "Reply from a named person within 24h — the quote above is the objection to answer.",
      basis: "classified negative with a quoted phrase",
    };
  }
  if ((m.intent_signals || []).some(i => i.tag === "comparison")) {
    return {
      text: "A comparison is being made in public. Make sure the comparison page ranks for this pairing.",
      basis: "the text contains a comparison phrase",
    };
  }
  if ((m.intent_signals || []).some(i => i.tag === "evaluating" || i.tag === "asking_advice")) {
    return {
      text: "Someone is choosing right now. Answer the specific question rather than linking the homepage.",
      basis: "the text shows active evaluation",
    };
  }
  if (m.sentiment === "positive" && m.author) {
    return {
      text: "Ask " + m.author + " whether this can be used as a quotable reference.",
      basis: "classified positive with a named author",
    };
  }
  return null;
}

module.exports = { build, ACTIONABLE };
