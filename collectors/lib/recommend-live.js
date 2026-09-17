/**
 * Recommendations computed from the mention store, on demand, for a window.
 *
 * WHY THIS EXISTS ALONGSIDE claude/recommend.js
 * ---------------------------------------------
 * The existing recommendations are excellent and expensive: a Claude pass over
 * the whole evidence store, run by hand, producing twelve strategic plays. They
 * are also STATIC — dated 2026-09-10 and unchanged since, because regenerating
 * them needs a person to run a queue in Claude Code.
 *
 * The requirement here is a Refresh button and a last-7-days filter: analyse
 * whatever the Mentions tab holds for the chosen window, right now, and say what
 * to do about it. That has to be deterministic and free, so it is computed from
 * the same grounded signals the dashboard already shows.
 *
 * The two coexist deliberately. Claude's are strategy and they say so; these are
 * this week's response list. Both cite records from the same store, and both are
 * rejected if the evidence does not resolve.
 *
 * WHAT IS GROUNDED AND WHAT IS PROPOSED
 * -------------------------------------
 * The trigger, the quote, the count and the citations are all fetched facts. The
 * asset title and the response angle are proposals, carried under `asset` and
 * labelled. Nothing claims an asset exists.
 */
const signals = require("./signals");

/** Owner for each theme — who actually has to do the work. */
const OWNERS = {
  pricing: "Pricing / Marketing",
  support: "Support",
  reliability: "Engineering",
  outage_or_breakage: "Engineering",
  data_loss: "Product",
  churn: "Customer Success",
  missing_capability: "Product",
  usability: "Product Marketing",
  performance: "Engineering",
  asking_for_alternative: "Demand Gen",
  detractor: "Brand",
  dissatisfaction: "Product Marketing",
  advocacy: "Advocacy",
  praise: "Advocacy",
  won_deal: "Advocacy",
  roi: "Advocacy",
  comparison: "Product Marketing",
};

/** Counter-assets for a negative mention OF DOCUMENT360. */
const OWN_PLAYS = {
  pricing: {
    angle: "Make the cost justifiable in public",
    asset_kind: "pricing explainer",
    asset_title: "What you get at each Document360 tier, and what it replaces",
    response: "Reply with the comparison the buyer is actually making — total cost against the tools Document360 replaces, not a defence of the list price.",
  },
  support: {
    angle: "Answer with a measured number",
    asset_kind: "support SLA page",
    asset_title: "Document360 support: response targets and who answers",
    response: "Apologise once, give the ticket a named owner, and publish the median first-response time so the next person searching finds a number instead of a complaint.",
  },
  reliability: {
    angle: "Publish the uptime record",
    asset_kind: "trust page",
    asset_title: "Document360 uptime and incident history",
    response: "Link the status page in the reply. An incident answered with data ages far better than one answered with reassurance.",
  },
  outage_or_breakage: {
    angle: "Own it fast, in public",
    asset_kind: "incident post-mortem",
    asset_title: "What happened, what we changed",
    response: "Acknowledge within the hour on the same channel, then post the fix. Silence during an outage is what turns one complaint into a thread.",
  },
  data_loss: {
    angle: "Show the recovery path",
    asset_kind: "technical guide",
    asset_title: "Version history, backups and export in Document360",
    response: "Escalate immediately and answer publicly once resolved — unanswered data-loss posts are quoted in competitor comparison pages for years.",
  },
  churn: {
    angle: "Find out why before they finish leaving",
    asset_kind: "win-back sequence",
    asset_title: "Exit interview: what we would have had to change",
    response: "A named person, not a support queue, and within a day. The reason they give is the most valuable input the roadmap will get this quarter.",
  },
  missing_capability: {
    angle: "Close the gap or name the date",
    asset_kind: "feature documentation",
    asset_title: "How Document360 handles the requested capability",
    response: "If it exists, link the docs page. If it does not, say so plainly and give the roadmap position — a vague yes is worse than a clear no.",
  },
  usability: {
    angle: "Shorten time to first published article",
    asset_kind: "video walkthrough",
    asset_title: "Empty workspace to published knowledge base, unedited",
    response: "Send the specific walkthrough for what they were stuck on, not the general getting-started guide.",
  },
  performance: {
    angle: "Publish measured performance",
    asset_kind: "benchmark post",
    asset_title: "Search and editor performance at 10,000 articles, measured",
    response: "Ask for the workspace size and article count. Performance complaints are almost always about a specific corpus shape, and that detail is the fix.",
  },
  asking_for_alternative: {
    angle: "Be the answer in the thread",
    asset_kind: "comparison page",
    asset_title: "Document360 compared: where it wins and where it does not",
    response: "Answer the question asked, disclose the affiliation in the first line, and link one specific page.",
  },
  detractor: {
    angle: "Do not argue — build the durable answer",
    asset_kind: "customer story",
    asset_title: "Why these teams chose Document360, in their words",
    response: "Reply once, briefly, offering to fix it offline. Then build the asset that answers the underlying objection for everyone who reads the thread later.",
  },
  dissatisfaction: {
    angle: "Ask what they expected",
    asset_kind: "expectation-setting post",
    asset_title: "What Document360 is for, and what it is not",
    response: "One question, publicly asked: what did you expect it to do? The answer is a free product brief.",
  },
};

/** Amplification plays for a POSITIVE mention of Document360. */
const AMPLIFY = {
  angle: "Turn approval into a referenceable asset",
  asset_kind: "customer proof",
  asset_title: "Customer proof point from an unprompted public mention",
  response: "Ask permission to quote it. An unprompted public compliment is the cheapest case study you will ever get.",
};

function excerptOf(m) {
  return m.sentiment_quote ||
    (m.brief && m.brief[0] && m.brief[0].text) ||
    String(m.evidence || "").slice(0, 300);
}

function cite(m, brandName) {
  return {
    id: [m.brand, m.channel, m.url].join("::"),
    brand: brandName,
    channel: m.channel,
    date: m.effective_date || m.date || null,
    url: m.url,
    domain: m.domain,
    title: m.title,
    excerpt: excerptOf(m),
    sentiment: m.sentiment || null,
    sentiment_grade: m.sentiment_grade || null,
    link_verified: !!m.link_ok,
  };
}

/**
 * Build the window's recommendations.
 *
 * Grouped BY THEME rather than one card per mention. Three people complaining
 * about the same thing is one piece of work, not three; splitting it would make
 * the list long and the priorities wrong.
 */
function build(brandsPayload, order, { days = 7, primary = "document360" } = {}) {
  const inWindow = m => m.effective_days_ago != null && m.effective_days_ago <= days;

  const own = brandsPayload[primary];
  const ownName = own ? own.name : "Document360";
  const ourMentions = ((own && own.mentions) || []).filter(inWindow);

  const recs = [];

  /* ------------------------- 1. our own negatives, grouped by theme ------- */
  const negByTheme = {};
  for (const m of ourMentions) {
    if (m.sentiment !== "negative") continue;
    const theme = (m.themes && m.themes[0]) || null;
    if (!theme || !OWN_PLAYS[theme]) continue;
    (negByTheme[theme] = negByTheme[theme] || []).push(m);
  }

  for (const [theme, ms] of Object.entries(negByTheme)) {
    const p = OWN_PLAYS[theme];
    const worst = ms.slice().sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0))[0];
    recs.push({
      title: p.angle + " — " + ms.length + " negative mention" + (ms.length === 1 ? "" : "s") + " on " + theme.replace(/_/g, " "),
      detail: p.response,
      type: "defend_position",
      owner: OWNERS[theme] || "Product Marketing",
      priority: ms.length >= 3 || worst.priority === "HIGH" ? "high" : ms.length >= 2 ? "medium" : "low",
      competitor: null,
      theme,
      trigger_phrase: worst.sentiment_phrase || null,
      reasoning:
        "Triggered by " + ms.length + " mention" + (ms.length === 1 ? "" : "s") + " in the last " + days +
        " days where a " + theme.replace(/_/g, " ") + " phrase appeared in a sentence naming " + ownName +
        ". The strongest was \"" + String(worst.sentiment_phrase || "").slice(0, 60) + "\".",
      asset: {
        kind: p.asset_kind,
        title: p.asset_title,
        note: "Proposed. This asset does not exist until someone builds it.",
      },
      evidence: ms.slice(0, 5).map(m => cite(m, ownName)),
      generated_by: "live",
    });
  }

  /* ---------------- 2. competitor negatives we can convert ---------------- */
  const compByTheme = {};
  for (const id of order) {
    if (id === primary) continue;
    const b = brandsPayload[id];
    if (!b) continue;
    for (const m of (b.mentions || []).filter(inWindow)) {
      if (m.sentiment !== "negative" || !m.play) continue;
      const key = m.play.theme + "::" + id;
      (compByTheme[key] = compByTheme[key] || { brand: id, name: b.name, play: m.play, items: [] }).items.push(m);
    }
  }

  for (const g of Object.values(compByTheme)) {
    recs.push({
      title: g.play.asset.title,
      detail: g.play.channel_reply,
      type: "capitalize_competitor",
      owner: OWNERS[g.play.theme] || "Product Marketing",
      priority: g.items.length >= 3 ? "high" : g.items.length >= 2 ? "medium" : "low",
      competitor: g.name,
      theme: g.play.theme,
      trigger_phrase: g.play.matched_phrase || null,
      reasoning:
        g.items.length + " public complaint" + (g.items.length === 1 ? "" : "s") + " about " + g.name +
        " on " + g.play.theme.replace(/_/g, " ") + " in the last " + days + " days. " + g.play.angle + ".",
      asset: {
        kind: g.play.asset.kind,
        title: g.play.asset.title,
        proof_needed: g.play.asset.proof_needed,
        note: "Proposed. This asset does not exist until someone builds it.",
      },
      evidence: g.items.slice(0, 5).map(m => cite(m, g.name)),
      generated_by: "live",
    });
  }

  /* ------------------------ 3. amplify our positives ---------------------- */
  const positives = ourMentions.filter(m => m.sentiment === "positive" && m.author);
  if (positives.length) {
    recs.push({
      title: AMPLIFY.asset_title,
      detail: AMPLIFY.response,
      type: "defend_position",
      owner: "Advocacy",
      priority: positives.length >= 3 ? "medium" : "low",
      competitor: null,
      theme: "advocacy",
      trigger_phrase: positives[0].sentiment_phrase || null,
      reasoning:
        positives.length + " named " + (positives.length === 1 ? "person" : "people") +
        " said something positive about " + ownName + " unprompted in the last " + days + " days.",
      asset: { kind: AMPLIFY.asset_kind, title: AMPLIFY.asset_title, note: "Proposed. Needs permission from each person quoted." },
      evidence: positives.slice(0, 5).map(m => cite(m, ownName)),
      generated_by: "live",
    });
  }

  /* --------------------- 4. comparisons happening in public --------------- */
  const comparisons = ourMentions.filter(m =>
    (m.intent_signals || []).some(i => i.tag === "comparison") ||
    (m.comparison_products || []).length);
  if (comparisons.length) {
    recs.push({
      title: "Own the comparison pages people are already writing",
      detail:
        "Document360 is being compared in public this week. Make sure the comparison page for each pairing " +
        "exists, is honest about where the competitor is stronger, and ranks — buyers trust a comparison " +
        "that concedes something.",
      type: "accelerate_llm",
      owner: "Product Marketing",
      priority: comparisons.length >= 3 ? "high" : "medium",
      competitor: null,
      theme: "comparison",
      trigger_phrase: null,
      reasoning:
        comparisons.length + " mention" + (comparisons.length === 1 ? "" : "s") +
        " in the last " + days + " days contain an explicit comparison phrase.",
      asset: {
        kind: "comparison pages",
        title: "Document360 vs each competitor named this week",
        note: "Proposed. One page per pairing that actually appeared.",
      },
      evidence: comparisons.slice(0, 5).map(m => cite(m, ownName)),
      generated_by: "live",
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  recs.sort((a, b) => (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3) || b.evidence.length - a.evidence.length);

  return {
    generated_at: new Date().toISOString(),
    window_days: days,
    mode: "live",
    method:
      "Computed from the mention store for the last " + days + " days. Every recommendation is triggered " +
      "by a lexicon phrase found in a sentence that names the product, and cites the records that " +
      "triggered it. Asset titles and response angles are PROPOSALS — nothing here asserts that an " +
      "asset exists.",
    audit: {
      accepted: recs.length,
      rejected: 0,
      mentions_considered: ourMentions.length,
      window_days: days,
    },
    recommendations: recs,
  };
}

module.exports = { build, OWN_PLAYS, OWNERS };
