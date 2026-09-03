# Collectors — the data pipeline

```
public web ──(adapters/)──▶ candidates ──(lib/pipeline.js)──▶ store/mentions.json ──(build.js)──▶ ../data/*.json
                                              │                        │
                                    the single verification      Claude judgement via
                                    gate — all sources           claude/*.js queues
                                    treated identically          (grounding-checked)
```

**Adapters discover. They never decide what counts.** All accuracy rules live in
[lib/pipeline.js](lib/pipeline.js) so they cannot drift between sources.

## Commands

```bash
npm run collect              # all adapters, 365-day window
npm run collect:90           # 90-day window
node collectors/collect.js --days=30 --only=youtube,blogfeed --brand=gitbook
npm run resolve:feeds        # re-prove blog + YouTube endpoints, writes store/resolved-feeds.json
npm run reverify:legacy      # re-run the old snapshot through the current gate
npm run build:data           # verified store → ../data/*.json
```

## Adapter contract

```js
module.exports = {
  id, label, channel,
  requires: [],                       // credentials/services needed
  available(),                        // { ok, reason }
  connectionStatus?(),                // for credential-gated adapters — drives the UI's "not connected"
  coverageLimit?,                     // structural limits, surfaced next to the numbers
  async collect({ sinceDays, log })   // → { candidates, gaps, unavailable? }
};
```

A candidate may set `published_at` (authoritative source date), `source_text` (feed/API text),
`source_verified` (the containing feed returned 2xx), and `trust_source_text: false` when its text did
**not** come from fetched bytes — the legacy re-verifier sets this, so old LLM-written snippets can
never become evidence.

## Store

| File | What |
|---|---|
| `store/mentions.json` | the evidence store — append-and-merge by (brand, channel, canonical URL) |
| `store/coverage.json` | last run: adapter statuses, gaps, rejections |
| `store/ai-visibility.json` | Claude + SERP answer-visibility measurements |
| `store/recommendations.json` | evidence-cited recommendations |
| `store/legacy-rejected.json` | old mentions that failed re-verification, with reasons |
| `store/classification-audit.json` | which classifications were applied vs rejected and why |
| `store/runs.json` | rolling run log |

Re-running a collector never duplicates a mention, and never discards a prior Claude classification
unless the page's content hash changed.

See the root [README](../README.md) for the verification gate, source list and known coverage limits.
