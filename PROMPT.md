# Working prompt for VS Code / Claude Code

Paste the block below. It is written to spend the fewest credits for the most
result: it tells the agent what already exists so it stops re-discovering it,
names the invariants so it does not have to re-derive them, and forbids the
three behaviours that have burned the most tokens on this project (rebuilding
from scratch, guessing at API shapes, and re-running full sweeps to check work).

---

## The prompt

```
Project: Document360 Competitive Intelligence dashboard.
Zero npm dependencies, Node 24, Windows. Run `npm test` (130 tests) before and
after any change — it is fast and it catches render, CSS and data-integrity
regressions that are invisible to reading the code.

READ THESE FIRST, THEN STOP READING. Do not survey the tree.
  collectors/lib/freshsources.js   the 11 keyless sources (the freshness floor)
  collectors/lib/signals.js        sentiment / briefs / priority / plays
  collectors/lib/live-refresh.js   what every Refresh button calls
  collectors/lib/opportunities.js  the Opportunities tab payload
  collectors/build.js  enrich()    where signals attach to records
  server.js                        all routes, one file
  public/js/app.js                 state, filters, routing, tabs

ARCHITECTURE, so you do not rediscover it:
- Collectors write collectors/store/*.json. build.js turns that into data/*.json.
  The browser only ever reads data/ via /api/*. Never let the browser read a key.
- Every mention is fetched bytes + a verbatim evidence excerpt. Nothing asserts
  a fact it cannot quote.
- Sentiment has FOUR states. "unclassified" is a real answer and is displayed;
  it is never rendered as neutral and never counted in a percentage.
- Two classification grades, counted separately, never summed into one number:
  `claude` (a model, checked against a grounded quote) and `lexicon` (a phrase
  matched inside a sentence that NAMES THE BRAND).
- Advice is not data. Anything proposed carries kind:"recommendation" and
  renders in the dashed `.op-play` block. Never let a suggested asset title
  look like a published one.

NON-NEGOTIABLE:
- Never fabricate a URL, author, date, quote, count, ranking or citation.
- If a source could not be queried, report a GAP. Never a zero. "Nobody said
  anything" and "we could not look" are different facts and must never render
  the same.
- Never use the Brand24 connector.
- Keys are server-side only. `require("./lib/env").load()` at the top of every
  entry point — four collectors silently had no keys because nothing called it.
- Preserve the existing UI, layout, colour tokens, navigation and filters. Do
  not redesign. New CSS uses the existing variables in public/css/styles.css.

BEFORE YOU WRITE CODE:
1. If you are integrating an API, READ ITS DOCS FIRST. Guessing endpoint shapes
   cost this project a whole session on ScrapeBadger — four wrong paths all
   returned identical errors and looked conclusive. The real path differed by
   one segment.
2. Check whether a lib already does it. freshsources / signals / scrape /
   serp-provider / live-refresh cover most of what gets asked for.

VERIFY LIKE THIS, NOT BY RE-SWEEPING:
- `npm test` for correctness.
- `node collectors/api-health.js` for provider state (~40s, no billable calls).
- `npm run sweep -- --days=1 --brand=document360` for a narrow live check.
- Never run a full `npm run sweep` or `npm run collect` just to confirm a change
  — it is 7+ minutes and rate-limits the free sources for the next run.

WHEN A FREE SOURCE RETURNS NOTHING, suspect a block before believing the zero.
DuckDuckGo serves its block page as HTTP 202 with 14KB and no results;
Hacker News is typo-tolerant; Stack Exchange always gzips. These are handled —
do not "fix" them by removing the guards.

TASK: <describe it in one or two sentences>

Work directly. Do not produce a plan document, do not summarise files back to
me, and do not paste large file contents into the chat. Make the change, run
the tests, and report what changed and what you measured.
```

---

## Why each part is there

**"Read these first, then stop reading"** — the single biggest credit sink is an
agent reading thirty files to answer a question that lives in two. Naming the
files caps the exploration.

**The architecture block** — without it, every session re-derives that
collectors write to `store/` and the browser reads `data/`. That is four or five
tool calls each time, every time.

**"Report a GAP, never a zero"** — this is the invariant the whole project rests
on, and it is the one most easily lost in a refactor. An empty result and an
unreachable source look identical in code and mean opposite things to a reader.

**"Read the docs first"** — recorded because of a real, expensive failure. Four
guessed endpoint paths returned the same error, which made a wrong conclusion
look well-evidenced. The rate limiter fired before routing, so a throttled call
and a wrong path were indistinguishable.

**"Verify like this, not by re-sweeping"** — a full sweep costs seven minutes
AND rate-limits the free sources, so verification by re-running degrades the
next real run. The narrow commands give the same signal in seconds.

**"Do not produce a plan document"** — plan documents for small changes cost as
much as the change.

## Useful one-liners

```bash
npm test                                   # 130 tests, ~20s
node collectors/api-health.js              # every provider, live, no spend
npm run sweep -- --days=1                  # narrow live sweep + rebuild
npm run sweep -- --brand=mintlify --no-build
npm run opportunities                      # competitor-negative totals
npm run env:audit                          # unused / undocumented keys
node collectors/build.js                   # rebuild data/ from the store
npm run discover                           # competitor sweep (self-sizing)
npm run directories                        # review-directory audit
```
