/**
 * AI answer-visibility measurement for all 7 tracked products.
 *
 *   node collectors/claude/ai-visibility.js build   → store/pending-ai-visibility.json
 *   node collectors/claude/ai-visibility.js apply   → validates + writes store/ai-visibility.json
 *   node collectors/claude/ai-visibility.js serp    → measures the web/SERP column (needs SearXNG)
 *
 * TWO COLUMNS, TWO DIFFERENT KINDS OF TRUTH — and the UI must not blur them.
 *
 * 1. CLAUDE (live, measurable here)
 *    Claude Code answers each buyer-intent prompt from its own knowledge, then
 *    reports which brands it named and in what order. The grounding check: Claude
 *    must return `answer_text`, and every brand it claims to have ranked must
 *    literally appear in that text. `apply` verifies each claimed brand with the
 *    same disambiguating matcher used for mentions. A brand claimed but absent
 *    from the answer text is DROPPED, so a rank can never be asserted without
 *    the sentence that produced it.
 *
 * 2. WEB / GOOGLE AI OVERVIEW (needs SearXNG)
 *    Measured by reading actual SERP results, not by asking a model what Google
 *    would say. Without a SearXNG instance this column reports "not connected"
 *    and stays empty. It is never estimated from the Claude column.
 *
 * ChatGPT / Gemini / Perplexity / DeepSeek remain unmeasured with no API keys and
 * are reported as unconnected — never inferred from Claude's answers.
 */
const path = require("path");
const { readJson, writeJson, saveAI, STORE_DIR } = require("../lib/store");
const { allBrands, matchBrand, brandOrder, brand } = require("../lib/brands");

const QUEUE = path.join(STORE_DIR, "pending-ai-visibility.json");
const ANSWERS = path.join(STORE_DIR, "claude-ai-answers.json");

/**
 * Buyer-intent prompts. Deliberately product-neutral except where a competitor
 * name is the actual query a buyer types — asking "best X alternatives" for every
 * brand is how share-of-answer is measured fairly across all 7.
 */
const PROMPTS = [
  "What are the best knowledge base software platforms in 2026?",
  "What is the best AI-powered documentation platform?",
  "What software is best for building a customer-facing help center?",
  "What are the best tools for an internal company knowledge base?",
  "What is the best knowledge base software with approval workflows, versioning and audit trails for regulated industries?",
  "What are the best alternatives to Confluence for team documentation?",
  "What are the best Document360 alternatives?",
  "What are the best GitBook alternatives for product documentation?",
  "What is the best documentation tool for developer and API docs?",
  "Which knowledge management tool is best for enterprise search across apps?",
];

function build() {
  writeJson(QUEUE, {
    built_at: new Date().toISOString(),
    tracked_brands: brandOrder().map(id => brand(id).name),
    prompts: PROMPTS,
    instructions: {
      task:
        "For EACH prompt: first answer it naturally from your own training knowledge, as you would for a real user. " +
        "Do NOT use web search or any tool — this measures your native answer. Then report what you said.",
      output_shape:
        '{"results":[{"prompt":"<verbatim>","answer_text":"<your full answer, >=400 chars>",' +
        '"brands_ranked":[{"brand":"<name as you wrote it>","position":1}],' +
        '"tracked_sentiment":{"<tracked brand name>":"positive|neutral|negative"}}]}',
      hard_rules: [
        "answer_text must be your ACTUAL answer, copied verbatim. Every brand in brands_ranked is checked against it mechanically; any brand not literally present in answer_text is discarded.",
        "position = the order you presented them in (1 = first/most prominent).",
        "List EVERY product you named, not only the tracked ones — share of answer is meaningless without the denominator.",
        "tracked_sentiment: only include a tracked brand you actually named, and only the sentiment your own answer expressed toward it.",
        "If a tracked brand did not come to mind, omit it. Do NOT add brands to be helpful or balanced — an absence is a real, useful measurement.",
        "Answer all " + PROMPTS.length + " prompts.",
      ],
    },
  });
  return { prompts: PROMPTS.length, queue: QUEUE };
}

function apply() {
  const file = readJson(ANSWERS, null);
  if (!file) return { ok: false, error: `no answers at ${ANSWERS}` };
  const results = Array.isArray(file) ? file : file.results || [];

  const audit = {
    prompts_returned: results.length,
    prompts_expected: PROMPTS.length,
    brands_claimed: 0,
    brands_dropped_not_in_answer: 0,
    dropped: [],
    short_answers: [],
  };

  const cleaned = [];
  for (const r of results) {
    if (!r || !r.prompt) continue;
    const answer = String(r.answer_text || "");
    if (answer.length < 200) {
      audit.short_answers.push({ prompt: r.prompt, length: answer.length });
    }

    // GROUNDING: keep only brands that literally occur in the answer text.
    const kept = [];
    for (const br of r.brands_ranked || []) {
      audit.brands_claimed++;
      const name = String(br.brand || "").trim();
      if (!name) continue;
      const present = answer.toLowerCase().includes(name.toLowerCase());
      if (!present) {
        audit.brands_dropped_not_in_answer++;
        audit.dropped.push({ prompt: r.prompt, brand: name, reason: "not present in answer_text" });
        continue;
      }
      kept.push({ brand: name, position: Number(br.position) || null });
    }

    // Map kept brands onto tracked ids using the disambiguating matcher, so
    // "Atlassian Confluence" and "Confluence Cloud" both resolve to `confluence`.
    const tracked = {};
    for (const k of kept) {
      for (const id of brandOrder()) {
        const m = matchBrand(k.brand + " knowledge base documentation", id);
        if (m.present) {
          if (!tracked[id] || (k.position && k.position < tracked[id].position)) {
            tracked[id] = { position: k.position, as_written: k.brand };
          }
        }
      }
    }

    // Sentiment only for tracked brands actually present.
    const sentiment = {};
    for (const [name, s] of Object.entries(r.tracked_sentiment || {})) {
      for (const id of brandOrder()) {
        const m = matchBrand(name + " knowledge base documentation", id);
        if (m.present && tracked[id] && ["positive", "neutral", "negative"].includes(s)) {
          sentiment[id] = s;
        }
      }
    }

    cleaned.push({
      prompt: r.prompt,
      answer_excerpt: answer.slice(0, 600),
      answer_length: answer.length,
      brands_ranked: kept,
      total_brands_named: kept.length,
      tracked: tracked,
      tracked_sentiment: sentiment,
    });
  }

  // Per-brand summary computed from verified data only.
  const summary = {};
  for (const id of brandOrder()) {
    const present = cleaned.filter(c => c.tracked[id]);
    const positions = present.map(c => c.tracked[id].position).filter(p => p != null).sort((a, b) => a - b);
    summary[id] = {
      prompts_measured: cleaned.length,
      present_in: present.length,
      share_pct: cleaned.length ? Math.round((present.length / cleaned.length) * 100) : null,
      median_position: positions.length ? positions[Math.floor((positions.length - 1) / 2)] : null,
      best_position: positions.length ? positions[0] : null,
      sentiment_counts: present.reduce((acc, c) => {
        const s = c.tracked_sentiment[id];
        if (s) acc[s] = (acc[s] || 0) + 1;
        return acc;
      }, {}),
    };
  }

  const existing = readJson(path.join(STORE_DIR, "ai-visibility.json"), {}) || {};
  saveAI({
    ...existing,
    measured_at: new Date().toISOString(),
    prompts: PROMPTS,
    claude: {
      status: "measured",
      model_runtime: "claude-code (user session, native knowledge, no web search)",
      results: cleaned,
      summary,
    },
    // Preserve any SERP measurement; do not fabricate one.
    web: existing.web || {
      status: "not_connected",
      reason:
        "Web / Google AI Overview measurement requires a SearXNG instance for SERP access. " +
        "Start one (docker compose -f collectors/searxng/docker-compose.yml up -d) then run: " +
        "node collectors/claude/ai-visibility.js serp",
      results: [],
    },
    other_models: {
      chatgpt: { status: "not_connected", reason: "no OpenAI API key configured — not measured, not estimated" },
      gemini: { status: "not_connected", reason: "no Gemini API key configured — not measured, not estimated" },
      perplexity: { status: "not_connected", reason: "no Perplexity API key configured — not measured, not estimated" },
      deepseek: { status: "not_connected", reason: "no DeepSeek API key configured — not measured, not estimated" },
    },
    audit,
  });
  return { ok: true, ...audit, brands_kept: cleaned.reduce((a, c) => a + c.brands_ranked.length, 0) };
}

/**
 * Measure the web/SERP column from real search results.
 * "Key sources AI cites" = the pages that actually rank for buyer prompts, which
 * is what a search-grounded assistant draws from. Requires SearXNG.
 */
async function serp() {
  const provider = require("../lib/serp-provider");
  const prov = await provider.resolve({ log: m => console.log(m) });
  if (prov.unavailable) return { ok: false, error: prov.note };
  const results = [];
  for (const p of PROMPTS) {
    const s = await prov.search(p, { days: 365 });
    if (!s.ok) {
      results.push({ prompt: p, measured: false, error: s.error, tracked: {}, sources: [] });
      continue;
    }

    // A zero-result response while every upstream engine is suspended means the
    // measurement DID NOT HAPPEN. Recording it as a measured zero would tell a
    // business user "this product appears in 0 of 10 Google results", which is a
    // false and damaging claim rather than a missing one.
    if (s.results.length === 0 && (s.unresponsive_engines || []).length > 0) {
      results.push({
        prompt: p,
        measured: false,
        error:
          "not measured — every upstream engine was rate-limited (" +
          (s.unresponsive_engines || []).map(e => (Array.isArray(e) ? e.join(": ") : e)).join(", ") +
          ")",
        tracked: {},
        sources: [],
      });
      continue;
    }

    const hits = s.results.slice(0, 20);
    // Which tracked brands appear in the ranked results, and where.
    const tracked = {};
    hits.forEach((h, i) => {
      const blob = `${h.title || ""} ${h.content || ""}`;
      for (const id of brandOrder()) {
        const m = matchBrand(blob, id);
        if (m.present && !tracked[id]) {
          tracked[id] = { rank: i + 1, evidence: blob.slice(0, 240), url: h.url };
        }
      }
    });
    results.push({
      prompt: p,
      measured: true,
      searched_at: new Date().toISOString(),
      result_count: hits.length,
      tracked,
      // Every cited source is a real ranking URL, with its position.
      sources: hits.map((h, i) => ({ rank: i + 1, url: h.url, title: h.title || null, engine: h.engine || null })),
    });
  }

  // Denominators must be the number of prompts ACTUALLY measured, never the
  // number attempted. Otherwise a blocked run silently dilutes every share_pct.
  const measured = results.filter(r => r.measured);
  const failed = results.filter(r => !r.measured);

  const summary = {};
  for (const id of brandOrder()) {
    const present = measured.filter(r => r.tracked && r.tracked[id]);
    const ranks = present.map(r => r.tracked[id].rank).sort((a, b) => a - b);
    summary[id] = {
      prompts_attempted: results.length,
      prompts_measured: measured.length,
      present_in: present.length,
      // null, not 0, when nothing was measured — "unknown" is not "zero".
      share_pct: measured.length ? Math.round((present.length / measured.length) * 100) : null,
      median_rank: ranks.length ? ranks[Math.floor((ranks.length - 1) / 2)] : null,
    };
  }

  const existing = readJson(path.join(STORE_DIR, "ai-visibility.json"), {}) || {};

  // If nothing was measured, do NOT overwrite a previously good measurement with
  // an empty one, and do NOT claim "measured".
  if (measured.length === 0) {
    const reason =
      `SERP measurement failed for all ${results.length} prompts — every upstream engine was ` +
      `rate-limited or CAPTCHA'd. No data was written, because recording zeros here would read as ` +
      `"these products appear in no search results", which is false. Wait for the suspension to clear ` +
      `(google cse suspends for ~180s, longer after repeated hits) and re-run: npm run measure:serp`;
    if (existing.web && existing.web.status === "measured") {
      // Preserve the earlier good data; just record that this attempt failed.
      saveAI({
        ...existing,
        web: {
          ...existing.web,
          last_attempt_failed_at: new Date().toISOString(),
          last_attempt_error: reason,
        },
      });
      return { ok: false, error: reason, preserved_previous: true };
    }
    saveAI({
      ...existing,
      web: { status: "measurement_failed", reason, attempted_at: new Date().toISOString(), results, summary: null },
    });
    return { ok: false, error: reason };
  }

  saveAI({
    ...existing,
    web: {
      status: measured.length === results.length ? "measured" : "partially_measured",
      method: `${prov.label} — real ranked SERP results, not a model's guess. ${prov.note}`,
      measured_at: new Date().toISOString(),
      prompts_attempted: results.length,
      prompts_measured: measured.length,
      partial_note: failed.length
        ? `${failed.length} of ${results.length} prompts could not be measured (engine rate limits). ` +
          `Shares are computed over the ${measured.length} that were, so they are not diluted by the failures.`
        : null,
      results,
      summary,
    },
  });
  return { ok: true, prompts: measured.length, failed: failed.length };
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === "build") {
    const r = build();
    console.log(`\nQueued ${r.prompts} buyer-intent prompts for Claude`);
    console.log(`  → ${r.queue}`);
    console.log(`\nClaude Code answers each, writes {"results":[…]} to`);
    console.log(`  collectors/store/claude-ai-answers.json, then:`);
    console.log(`  node collectors/claude/ai-visibility.js apply\n`);
  } else if (cmd === "apply") {
    const r = apply();
    if (!r.ok) { console.error("  ! " + r.error); process.exit(1); }
    console.log(`\nAI visibility applied: ${r.prompts_returned}/${r.prompts_expected} prompts`);
    console.log(`  brands claimed: ${r.brands_claimed}, kept: ${r.brands_kept}`);
    if (r.brands_dropped_not_in_answer)
      console.log(`  DROPPED ${r.brands_dropped_not_in_answer} brand claim(s) not present in the answer text`);
    if (r.short_answers.length)
      console.log(`  ${r.short_answers.length} answer(s) shorter than 200 chars — flagged in store/ai-visibility.json`);
    console.log("");
  } else if (cmd === "serp") {
    serp().then(r => {
      if (!r.ok) { console.error("  ! " + r.error); process.exit(1); }
      console.log(`\nSERP column measured across ${r.prompts} prompts\n`);
    });
  } else {
    console.log("usage: node collectors/claude/ai-visibility.js build | apply | serp");
  }
}

module.exports = { build, apply, serp, PROMPTS, QUEUE, ANSWERS };
