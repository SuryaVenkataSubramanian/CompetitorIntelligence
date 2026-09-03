---
name: refresh-intel
description: Refresh the Document360 competitive-intelligence dashboard. Runs the deterministic collectors, then performs the Claude analysis steps (sentiment classification, AI answer-visibility measurement, recommendations) and rebuilds data/. Use when asked to refresh, update, re-collect or re-analyse the competitive intelligence data, or when the dashboard is stale.
---

# Refresh competitive intelligence

You are the analysis engine for this dashboard. Claude is the default logic here by
design — there is no LLM API key, so **you** are the model runtime, working through
queue files that Node writes and validates.

## The rule that governs every step

**You classify and judge. You never generate facts.**

Node has already fetched every page, confirmed each brand name literally appears in
the fetched text, and extracted a verbatim excerpt. Your job is judgement on that
text. Every answer you give is mechanically validated:

- A sentiment call must quote a **contiguous substring** of the excerpt you were shown.
- A brand you claim appeared in an AI answer must literally occur in the `answer_text` you return.
- A recommendation must cite `evidence_ids` that resolve to real records in the store.

Anything that fails these checks is **discarded, not corrected**. Do not try to
satisfy the checker — just be accurate, and leave things unclassified when the
evidence is thin. An unclassified record renders as "unclassified" in the UI and is
excluded from metrics, which is the correct outcome for "we don't know".

Never invent a URL, date, funding figure, customer name, or product claim. If you
notice a gap, report it — gaps are shown to the user as coverage notes.

## Steps

Run these in order. Report what actually happened at each step, including failures.

### 1. Collect (deterministic — no judgement)

```bash
node collectors/collect.js --days=365
```

Read the summary. Note which adapters were `dormant` (missing credentials) and
which coverage gaps appeared. Do not attempt to fill a dormant source's data.

If the legacy snapshot has not been re-verified yet:

```bash
node collectors/reverify-legacy.js
```

### 2. Classify sentiment

```bash
node collectors/claude/queue.js build
```

Read `collectors/store/pending-classification.json`. For each item you get a brand
name, a channel, and an evidence excerpt — deliberately **no URL, domain or title**,
so you judge the text rather than the reputation of the source.

Classify each one:

- `positive` — the text expresses approval or an advantage for the brand
- `negative` — criticism, a limitation, or a competitor preferred over it
- `neutral` — named without evaluation (listings, factual/feature descriptions)

For each, return the `id` verbatim, the `sentiment`, a `quote` copied
character-for-character from that item's excerpt, and a one-clause `rationale`.

Write `{"answers":[…]}` to `collectors/store/claude-answers.json`, then:

```bash
node collectors/claude/queue.js apply
```

If items were rejected for an ungrounded quote, that means the quote wasn't
literally in the excerpt. Fix those specific items by re-reading the excerpt and
copying exactly — do not restate the classification.

Batch large queues (roughly 40–60 items per write) so a single malformed file
doesn't cost the whole run.

### 3. Measure AI answer visibility

```bash
node collectors/claude/ai-visibility.js build
```

Read `collectors/store/pending-ai-visibility.json`. For **each** prompt:

1. Answer it naturally from your own training knowledge, exactly as you would for a
   real user. **Do not use WebSearch or any tool** — this measures your native answer.
   Using search would measure something else entirely and make the column a lie.
2. Then report: the full `answer_text` verbatim, every product you named with its
   position, and the sentiment your answer expressed toward any tracked brand.

Be honest about absence. If Document360 didn't come to mind for a prompt, omit it —
a measured absence is a real finding and the dashboard is built to show it. Do not
add brands for balance.

Write `{"results":[…]}` to `collectors/store/claude-ai-answers.json`, then:

```bash
node collectors/claude/ai-visibility.js apply
```

For the Web / Google AI Overview column, if SearXNG is running:

```bash
node collectors/claude/ai-visibility.js serp
```

If it isn't, leave it — the column will correctly render as "not connected". Never
estimate the web column from your own answers.

### 4. Generate recommendations

```bash
node collectors/claude/recommend.js build
```

Read `collectors/store/pending-recommendations.json`. Produce 10–16 recommendations
grounded **only** in the supplied signals.

Requirements that are checked:

- `evidence_ids` — at least one id copied verbatim from the signals list
- `title` — an imperative that names the artifact, and is **not** a prefix of `detail`
- No fact absent from the cited excerpts (no funding figures, pricing, or customer
  counts unless they appear in an excerpt you cite)
- Only reference AI-answer share if `ai_visibility_summary` is present in the queue

Where a competitor is genuinely stronger, say where to compete instead. Never
recommend publicly attacking a named competitor.

Return fewer than 10 if the signals don't support 10. Padding is worse than a short list.

Write `{"recommendations":[…]}` to `collectors/store/claude-rec-answers.json`, then:

```bash
node collectors/claude/recommend.js apply
```

### 5. Rebuild the dashboard data

```bash
node collectors/build.js
```

## Report back

Tell the user plainly:

- verified records by brand × channel, and how many carry an exact date
- how many records are still unclassified
- which sources are dormant and what credential each needs
- which coverage gaps affect which date ranges (GDELT's 90-day window, YouTube's
  15-item feed cap, LinkedIn/X being search-index floors rather than totals)
- anything you rejected and why

Do not summarise this as "done" if steps failed. State what worked and what didn't.
