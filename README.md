# Document360 — Competitive Intelligence (v2)

A self-owned competitive-intelligence dashboard tracking **7 products** across **8 channels**, with no
Brand24 and no third-party monitoring connector.

Tracked: **Document360**, **Mintlify**, **GitBook**, **Confluence**, **Guru**, **Bloomfire**, **KnowledgeOwl**

| Group | Channels |
|---|---|
| Social | LinkedIn · X · YouTube · Instagram · Facebook |
| Blogs & Web | Blogs · Web |
| Events | Events & Sponsorships |

## Running it

```bash
npm run searxng:local     # search backend (no Docker, no admin — see below)
npm start                 # dashboard on http://localhost:3000
npm run refresh:start     # detached hourly refresh — survives the terminal closing
npm run refresh:status    # service state, tick history, data staleness
npm run refresh:stop
```

`refresh:hourly` runs in the foreground and dies with the terminal — which is how the data went 12 days
stale. `refresh:start` runs the same loop **detached** with a pidfile, and each tick checks SearXNG and
restarts it if it has died.

The dashboard lands on **Mentions**: one matrix (7 products × 8 channels), one row of filter chips, one
list. The old Overview screen — KPI tiles, bar chart, donut, channel grid, caveat banner, integrity strip
and mention list all on one page — was removed for being unreadable.

---

## The one rule everything else follows

> **A number appears in this dashboard only if it was computed from fetched bytes or a mechanically
> verified Claude judgement. Nothing is inferred, estimated, or filled in.**

A record earns its place by passing a five-step gate:

| Step | What must be true | Where |
|---|---|---|
| **Fetch** | the URL was requested; HTTP status, byte count and SHA-256 of the body are recorded | [collectors/lib/fetch.js](collectors/lib/fetch.js) |
| **Confirm** | a brand alias literally appears in the fetched text | [collectors/lib/brands.js](collectors/lib/brands.js) |
| **Evidence** | a verbatim excerpt *containing the brand name* was extracted | [collectors/lib/verify.js](collectors/lib/verify.js) |
| **Date** | parsed from JSON-LD, meta tags, `<time>` or an authoritative feed — or the record is marked undated | [collectors/lib/verify.js](collectors/lib/verify.js) |
| **Sentiment** | Claude classified it from the excerpt and returned a quote that is a **contiguous substring** of it | [collectors/claude/queue.js](collectors/claude/queue.js) |

Records that fail are kept in `data/audit.json` **with the reason**, so exclusions are inspectable
rather than invisible.

### Why the sentiment check matters

Claude is shown only the brand name and the evidence excerpt — **no URL, domain or title** — so it
judges the text rather than the reputation of the source. It must return a quote copied from that
excerpt, and `apply` re-checks the substring mechanically. A fabricated justification cannot survive:

```
$ # submitting a plausible but invented quote
$ node collectors/claude/queue.js apply
Applied 0 classification(s)
  rejected 1:
    1 ungrounded quote (not found in the evidence shown)
```

There is **no heuristic fallback**. An unclassified record renders as `unclassified` and is excluded
from every sentiment figure — because "we don't know" and "it's neutral" are different business facts.

---

## Quick start

Requires **Node.js ≥ 18**. No npm dependencies.

```bash
npm start          # serve the dashboard on http://localhost:3000
```

To collect fresh data and re-analyse:

```bash
npm run collect            # deterministic collectors (no LLM, no credentials)
# then, in Claude Code:
/refresh-intel             # Claude classifies sentiment, measures AI visibility, writes recommendations
npm run build:data         # rebuild data/ from the verified store
```

---

## Claude is the analysis engine, by design

There is no LLM API key. **The Claude Code session you are already running is the model runtime.**
Node does all fetching and all validation; Claude only performs judgement on text Node proved was
fetched. The contract lives in [.claude/skills/refresh-intel/SKILL.md](.claude/skills/refresh-intel/SKILL.md)
and works through queue files:

| Queue | Claude's job | Validation on the way back |
|---|---|---|
| `store/pending-classification.json` | sentiment per mention | quote must be a substring of the excerpt shown |
| `store/pending-ai-visibility.json` | answer buyer prompts natively, report brands named | every brand claimed must literally appear in `answer_text` |
| `store/pending-recommendations.json` | recommendations from verified signals | every `evidence_id` must resolve against the store |

Each step also runs standalone: `npm run queue:sentiment` / `apply:sentiment`, `queue:ai` / `apply:ai`,
`queue:recs` / `apply:recs`.

---

## Data sources

### Live now — no credentials needed

| Source | Channel | Notes |
|---|---|---|
| **Brand blog/changelog RSS** | Blogs | first-party, exact dates. Endpoints proven by `npm run resolve:feeds` |
| **YouTube channel RSS** | Videos | `feeds/videos.xml?channel_id=…` — no API key, no quota, exact timestamps |
| **Hacker News (Algolia)** | Web | free, exact ISO dates, **full history** — the only no-credential source that truly covers 365 days |
| **Google News RSS** | Web | *discovery only* — see the caveat below |
| **GDELT DOC 2.0** | Web | free, no key, 65 languages — but a ~90-day rolling window and 1 req/5s |

### Requires SearXNG (self-hosted, no API key)

[SearXNG](https://github.com/searxng/searxng) replaces a paid SERP API (SerpAPI / Serper / Brave). It is
also **how LinkedIn and X get coverage without platform credentials**, via `site:` queries against the
underlying engines.

**Option A — Docker** (if you have it):

```bash
npm run searxng:up     # docker compose, JSON API already enabled
SEARXNG_URL=http://localhost:8888 npm run collect
```

**Option B — Windows-native, no Docker, no admin** (verified working):

SearXNG officially supports Linux only, but it runs on Windows because **none of its declared
dependencies are Linux-only** (no `uvloop`, no `uwsgi`, no `setproctitle` — check `requirements.txt`).
Three things are needed, and `npm run searxng:local` handles all of them:

```bash
winget install --id Python.Python.3.12 --scope user        # no admin needed
git clone --depth 1 https://github.com/searxng/searxng.git vendor/searxng
<python> -m venv vendor/searxng/.venv
vendor/searxng/.venv/Scripts/python -m pip install -r vendor/searxng/requirements.txt
npm run searxng:local        # starts it; npm run searxng:status to check
```

Two Windows-specific gotchas, both handled:

- **4 files fail to check out**: `utils/templates/.../searxng.conf:socket` — a colon is illegal in NTFS
  filenames. They are nginx/uwsgi deployment templates, irrelevant here; the application checks out fine.
- **`searx/valkeydb.py` imports POSIX-only `pwd`** at module level, so SearXNG cannot even start.
  [collectors/searxng/winshim/pwd.py](collectors/searxng/winshim/pwd.py) supplies it via `PYTHONPATH`.
  An audit found `pwd` used on exactly one line — a log message reached only when a Valkey connection
  fails, and this deployment configures no Valkey. Neither the venv nor the vendored checkout is
  modified, so `git pull` in `vendor/searxng` stays clean.

### Engine selection is the whole ballgame

Only `google cse` was enabled, and it suspends after ~40 queries — that single point of failure caused
every "blocked by upstream engine rate limits" gap. This build offers **61** general engines. Probing
each one individually found **13 that return on-brand results**:

```bash
npm run searxng:engines        # re-probe any time; prints a paste-ready engine list
```

| Engine | On-brand |  | Engine | On-brand |
|---|---|---|---|---|
| `google cse` | 20/20 | | `searchch` | 8/10 |
| `yandex` | 15/15 | | `abcnyheter` | 7/7 |
| `naver` | 13/15 | | `360search` | 7/7 |
| `duckduckgo` | 10/10 | | `yahoo` | 7/7 |
| `fynd` | 10/10 | | `boardreader` | 2/2 |
| `privacywall` | 10/10 | | `ddg definitions` | 2/2 |
| `seznam` | 10/10 | | | |

**Result: 83 results from 10 engines with zero unresponsive**, up from 20 results from 1 engine that
suspended a third of the way through every run.

Note `duckduckgo` works *through* SearXNG even though it CAPTCHAs a direct scraper — SearXNG formats and
rotates requests properly. And `bing` stays **disabled**: it responds but returns 0/10 on-brand. A failing
engine is harmless (SearXNG marks it unresponsive and the adapter records a coverage gap); an engine
returning confident, well-formed, *wrong* results is the genuinely dangerous case.

**Rate limits are the real constraint.** `google cse` suspends after roughly 40 queries
(`suspended_time=180`). A full run is ~63 queries, so the first attempt collected three brands and
silently returned nothing for the other four. The adapter now paces queries, waits out suspensions, and
— critically — records a **measurement failure** rather than a zero when every engine is suspended:

> `LinkedIn posts/pages via public index: no results because every upstream engine was rate-limited
> (google cse: Suspended: too many requests). This is a MEASUREMENT FAILURE, not an absence of
> mentions — the linkedin channel is under-reported for Guru. Re-run after the suspension clears.`

Collect brand-by-brand to stay inside the budget: `node collectors/collect.js --days=365 --only=searxng --brand=guru`

> SearXNG ships with `format=json` **disabled**. The bundled
> [settings.yml](collectors/searxng/settings.yml) enables it under `search.formats` — without that,
> every collector call returns HTML and the adapter correctly refuses to invent data from it.

SearXNG powers: SERP / Web-AI-Overview measurement, the **Events** channel (sponsorship is not exposed
by any API, so it is detected by requiring both a brand name and a sponsorship term on a fetched page),
Google News link resolution, and blog discovery for the three brands with no RSS feed.

### Credential-gated — currently dormant

Both are **wired and ready**, contribute **nothing** until credentials exist, and render in the UI as
*"not connected"* — never as a measured zero.

| Source | Repo | Needs |
|---|---|---|
| **LinkedIn** | [joeyism/linkedin_scraper](https://github.com/joeyism/linkedin_scraper) (`CompanyPostsScraper`) | `LINKEDIN_LI_AT` + `npm run setup:python` |
| **X** | [d60/twikit](https://github.com/d60/twikit) | `X_USERNAME`, `X_EMAIL`, `X_PASSWORD` + `npm run setup:python` |

[josephlimtech/linkedin-profile-scraper-api](https://github.com/josephlimtech/linkedin-profile-scraper-api)
is Node/Puppeteer and **profile-only** — useful for enriching a named author, not for finding mentions,
so it is wired for that narrow role only.

**Stated once as fact:** automating LinkedIn and X is contrary to their terms and can get an account
restricted. Use a burner account. Where SearXNG's `site:` search is sufficient, prefer it — it needs no
credential and no automation against those platforms.

---

## Bright Data — what this account can and cannot do

Probed live, not assumed. Re-run with `npm run brightdata:probe`; the result is stored in
`collectors/store/brightdata-capabilities.json` and every adapter reads it.

| Capability | Status | Evidence |
|---|---|---|
| Web Scraper API (`/datasets/v3/*`) | **works** | trigger → snapshot → download, verified end to end |
| Dataset catalogue (`/datasets/list`) | **works** | 1,755 datasets |
| SERP API / Web Unlocker (`POST /request`) | **blocked** | `/zone/get_active_zones` returns `[]`; `/status` reports `can_make_requests:false, auth_fail_reason:"zone_not_found"` |
| ChatGPT / Claude / Gemini / Perplexity scrapers | **absent** | no such dataset in this account's catalogue |

The account has **no zone provisioned**, so arbitrary-URL fetching and Google AI-Overview scraping
through Bright Data are unavailable. Creating a zone is a billable account change, so it is
**reported rather than done silently**. Everything blocked renders as *"not available — <reason>"*,
never as a zero.

Discovery collectors per dataset, enumerated by asking the API (a deliberately invalid
`discover_by` makes it list the valid ones):

```
linkedin_posts     url, profile_url, company_url        ← no keyword discovery
reddit_posts       subreddit_url, keyword, author_url
youtube_videos     keyword, url, search_filters, hashtag, explore, podcast_url
x_posts            profile_url, profiles_array
instagram_posts    url
facebook_posts     (none — URL input only)
```

### LinkedIn, in four stages

Because the LinkedIn dataset has **no keyword discovery**, keyword coverage is obtained indirectly:

1. **seeds** — the five supplied `lnkd.in` links, resolved through their redirect
2. **search** — SearXNG finds `linkedin.com/posts` URLs per keyword, Bright Data then scrapes them
3. **company** — `company_url` discovery over all 7 products' company pages *(the volume lever:
   463 posts from one pass)*
4. **profile** — `profile_url` discovery over authors already seen mentioning a tracked product

A post is only recorded against a product when `matchBrand()` confirms it in the post's **own text**.
The keyword that surfaced a URL is never sufficient.

Result: LinkedIn went from effectively unusable to **248 Document360 records** and 1,274 total records
in the store.

## AI Visibility — all six surfaces, measured

Enter any buyer prompt; the selected brand is checked across six AI surfaces. Every one returns a
**real answer with real citations**, via DataForSEO's AI Optimization API:

| Surface | Endpoint | Cost/call |
|---|---|---|
| ChatGPT | `/v3/ai_optimization/chat_gpt/llm_responses/live` | ~$0.077 |
| Claude | `/v3/ai_optimization/claude/llm_responses/live` | ~$0.050 |
| Gemini | `/v3/ai_optimization/gemini/llm_responses/live` | ~$0.038 |
| Perplexity | `/v3/ai_optimization/perplexity/llm_responses/live` | ~$0.006 |
| Google AI Overview | `/v3/serp/google/ai_mode/live/advanced` | ~$0.004 |
| Google organic | `/v3/serp/google/organic/live/advanced` | ~$0.002 |

A measured example — *"What are the best knowledge base software platforms in 2026?"*:

```
ChatGPT             #1   named 4   6 citations   4047-char answer
Claude              #1   named 5   7 citations   1482-char answer
Gemini              #3   named 4  13 citations   4713-char answer
Perplexity          #1   named 4  20 citations   2568-char answer
Google AI Overview  #1   named 3   3 references  2257-char answer
Google / Web        #2            19 results
```

### How a rank is derived from prose

An LLM answer is prose, not a ranked list, so "position" has to be derived — and it is derived
**mechanically**: the order of each brand's first confirmed occurrence in the answer text. That is
reproducible, and the full answer is stored so any position can be checked by reading it. `matchBrand`
must confirm the brand in the answer before anything is recorded, so *"a confluence of factors"* cannot
become a Confluence sighting.

Verified: **5 of 5** asserted ranks in the example above are grounded in the stored answer text.

### Three states, never conflated

```
measured + visible:false   we asked; the brand was absent. A finding.
not_checked                we did not ask (no budget, no credential). NOT an absence.
failed                     we asked and the call errored.
```

Coverage is shown beside every metric, and every rate divides by *measured* checks only.

### Windsor.ai — the outcome layer, and the fallback

DataForSEO answers *"does ChatGPT name Document360"*. Windsor.ai → Google Analytics 4 answers the
question that follows: **did anyone actually arrive from ChatGPT.** Measured over 90 days on the
Document360 property:

```
ChatGPT       2,578 sessions   74.2% of AI traffic
Claude          443            12.7%
Gemini          302             8.7%
Perplexity      116             3.3%
Copilot          37             1.1%
                ─────
AI total      3,476 of 366,492 sessions  (0.95% of all traffic)
```

And where those visits land — the actionable half:

```
1,220  /                                    homepage
   72  /pricing                             pricing — buying intent
   38  /docs
   27  /docs/embed-youtube-shorts
   18  /signup                              signup or demo
   17  /docs/mcp
```

`/pricing` receiving 72 sessions from AI assistants is a buying-intent signal no ranking figure shows.

**This is free to query**, so it is also the fallback: when the budget guard stops a surface, that
surface's card shows its referral traffic instead of an empty "not checked" — labelled as traffic, not
as a rank, because they are different measurements and conflating them would be sloppy.

Connected on this account: `googleanalytics4` (property *Docs Document360*), `youtube` (742 videos on
the own channel), `linkedin` (ads). `npm run windsor:enrich` joins the YouTube figures onto stored
mention records **by video id only** — 12 records now carry real view counts (up to 136,324 views)
instead of "no engagement data". Nothing is matched on title similarity.

**First-party means Document360 only.** GA4 cannot see a competitor's traffic, so this panel reports
*unavailable* for the other six products rather than zero. Selecting another product says so explicitly.

### Cost control, because these calls are billable

The account holds **$1.00** and a full six-surface probe costs **~$0.18**. So:

- **ChatGPT and Claude only, by default.** Those two carry most buyer evaluations, and a two-surface
  probe costs ~$0.13 rather than ~$0.18. One-click presets switch to *free only* or *all six*.
- **Every call is budget-checked first.** `DATAFORSEO_MAX_PROBE_COST` caps one probe;
  `DATAFORSEO_MIN_BALANCE` keeps a reserve. A blocked call reports *not checked — budget*, never a
  silent failure that would read as absence — and falls back to first-party referral traffic.
- **Answers are cached for 7 days.** Re-opening a prompt costs nothing.
- **Surfaces are selectable** in the UI, with the per-surface cost shown before you spend it.
- **The balance and remaining probe count are shown** above the search box.
- Actual spend is recorded in `collectors/store/dataforseo-spend.json`.

Clicking a result opens the **full answer** — the model's verbatim text, which brands it named and
where, and its citation list. Redirecting the reader to re-ask the question elsewhere was only ever a
stand-in for not having the answer; a quiet `open ↗` link remains for spot-checking by hand.

One caveat worth knowing: Gemini returns every citation through
`vertexaisearch.cloud.google.com/grounding-api-redirect/…`. That is Google's redirector, not a
publisher — it ranked as the third most authoritative domain in the category until it was handled.
The real domain is recovered from the citation title where possible, and otherwise reported as
*publisher not recoverable* rather than named as a source.

## Deploying and sharing with the team

Full instructions in **[DEPLOY.md](DEPLOY.md)**. The short version:

```bash
npm run deploy:check      # scans every file git would publish for your API keys
git init && git add -A && git commit -m "Document360 competitive intelligence"
git remote add origin https://github.com/SuryaVenkataSubramanian/CompetitorIntelligence.git
git branch -M main && git push -u origin main
```

Then import the repo at [vercel.com/new](https://vercel.com/new) — no build
settings to change.

### The deployment splits in two, because the halves need different things

|  | Runs on | Needs |
|---|---|---|
| **Dashboard** | Vercel | Nothing but the committed `data/` |
| **Collection** | Local or GitHub Actions | Writable disk, minutes of runtime, SearXNG on localhost |

A serverless function has none of the second column, so the hosted app is a
**reader** of data collected elsewhere — plus the live AI-visibility probe,
which is plain HTTP and works anywhere. `.github/workflows/collect.yml` does
the collecting daily and commits the result, which redeploys Vercel with fresh
data.

Endpoints that need a child process return **HTTP 501 with the reason and
where to run them instead**, rather than failing in a way that reads as missing
data.

### Two required Vercel variables

- **`SESSION_SECRET`** — generate with `npm run session:secret`. Without it
  nobody stays signed in, because each cold start is a new process.
- **`AUTH_USERS_JSON`** — the contents of `collectors/store/auth-users.json`.
  That file is gitignored (it holds the password hashes), so a fresh deploy has
  no accounts and every login would be rejected.

### Sessions behave differently when hosted, and it is a real trade-off

Locally, sessions are opaque tokens in memory and **logout genuinely revokes**.
On Vercel they are HMAC-signed cookies, so `logout` clears the cookie but
cannot invalidate a copied token. Bounded by a 12-hour expiry inside the
signature, and by a **password fingerprint** in the token — rotating a password
invalidates every token issued for the old one. So revocation still works for
the case that matters.

Verified across both modes: login, session, a cookie surviving a cold start, a
different secret rejecting it, a forged email failing the signature, and
stateful logout revoking server-side.

## Verifying that every API works

```
npm run api:health          all sources, billable calls skipped
npm run api:health -- --paid additionally proves the LLM path end to end
npm run audit:mentions      structural audit of all 1,274 records
npm run audit:mentions:live re-fetches a sample and re-confirms the brand on the page
```

Current state:

```
[  OK  ] SearXNG          72 results from 8 engines (3 unresponsive)
[ WARN ] Octolens         watches [Mintlify, document360, Gitbook]; no coverage for 4 of 7 products
[ WARN ] NewsAPI          1 total result for "Document360"; developer plan caps at page 1
[ WARN ] Bright Data      Web Scraper API works; /request API has no zone provisioned
[ WARN ] DataForSEO       all 4 LLM providers reachable; balance limits probes
[ WARN ] Claude runtime   sentiment classified on 105/1274 records
[ WARN ] SMTP             not configured — digests are stored, not sent
```

Every `WARN` is a real coverage limit with a stated remedy, not a failure to reach the API.

### Recommendations that produce the asset

For each prompt where Document360 is measured as **absent**, `npm run assets:build` hands Claude the
competitors that ranked, their positions, and every citing domain with its URL. Claude writes the
finished asset — actual LinkedIn copy, actual Reddit post, actual blog draft. `npm run assets:apply`
enforces five gates mechanically, and a failing asset is **dropped**:

```
unknown_prompt      the prompt was never probed
ungrounded_url      cites a URL that was not supplied as evidence
incomplete_asset    missing a field its channel needs, or below the length floor
out_of_scope        never mentions Document360
fabrication         asserts an award, analyst placement or customer statistic
generic_why         rationale names no competitor or source from this prompt's evidence
```

All six were verified by submitting one deliberately bad asset per gate; all six were rejected.

## New Competitors — classification and threat scoring

Every entrant carries: product, company, website, launch/discovery date, category, competitive
classification, threat score 0-100, why it could compete, evidence URL and two confidences.

**Classification requires evidence, not keywords.** No signal fires on the search term that surfaced a
product — only on phrases it publishes about *itself* (title, meta description, homepage body), and
each signal records the phrase it matched and where. So a score of 76 can be taken apart:

```
Ferndesk  76/100  direct_competitor
  Same product category      +30/30   "help center"      title/description
  AI-native capability       +17/20   "AI-native"        title/description
  Enterprise overlap         +12/20   "SSO", "SAML"      homepage body
  Commercially ready         +11/15   "Pricing"          homepage body
  Recent launch / momentum   + 6/15   "just launched"    homepage body
```

Two dates are kept strictly separate: `launch_date` (from the site's own words, often unknown) and
`first_seen` (when discovery found it). A product found today is not a product launched today.

## Review-directory audit — 7 directories × 6 categories

```
npm run directories             audit every directory × category
npm run directories:resolve     also resolve and assess vendor websites
npm run directories -- --dir=g2 --cat=sop      one slice
```

G2, Capterra, GetApp, TrustRadius, Gartner Peer Insights, SoftwareAdvice and SoftwareSuggest, across
Knowledge Base, Customer Self-Service, Contact Center Knowledge Base, Standard Operating Procedures,
AI Documentation Generators and API Documentation. A directory listing is a later signal than web
discovery: it means a product has entered a buyer's comparison set.

Current audit — **116 products**, 16 on two or more directories:

```
Knowledge Base                  41        G2                      20
Customer Self-Service            9        Capterra                34
Contact Center Knowledge Base   12        GetApp                  11
Standard Operating Procedures   46        TrustRadius             13
AI Documentation Generators      8        Gartner Peer Insights   15
API Documentation                6        SoftwareAdvice          21
                                          SoftwareSuggest         22
```

### How they are read, and why it is not scraping

Five of the seven return **HTTP 403** to a direct fetch. Their robots.txt files do **not** forbid
product or category pages — TrustRadius says `Allow: /`, and the Disallow rules target query-string
noise, `/search`, `/api` and compare permutations. It is a WAF refusing us, not a policy.

So rather than defeat the bot protection, the collector reads **Google's and Bing's public index via
SearXNG** using `site:` queries. Those engines crawled the pages legitimately, no bot wall is touched,
and the query costs nothing — which is what makes a *daily* audit affordable where a paid SERP API at
$0.002 × 126 queries would not be.

### The precision problem, and the three gates that solve it

A category-scoped search returns products that merely rank for the phrase. Every rejection below is a
real measured false positive from a looser first pass:

| Gate | What it rejects | Measured examples |
|---|---|---|
| **Product page** | compare / alternatives / category URLs | `g2.com/products/x/competitors/alternatives` |
| **Generic name** | names built only from category words | "Customer Portal", "Knowledge Management", "Contact Center Knowledge Base Software", "Free Document Maker" |
| **Category confirmation** | the listing's own text must place it in the category | **Paylocity** (payroll — *"a straightforward self-service portal"*), **Zoho Analytics** (*"self-service BI"*), **Invoiced**, **Axual** (*"self-service … for your Kafka implementation"*), **Azure AI Document Intelligence** and **Lido** (document *processing*, not documentation), **Kong Konnect** (*"mTLS, traffic policies, observability"*), **CoinGecko API** |

The last gate judges the **listing's own title and snippet**, never the query that found it — the same
rule web discovery uses. Two discriminators do most of the work: `self-service` must co-occur with a
knowledge/support noun, and **"documentation"** (authoring) is required over **"document"** (a file).

Result: 116 admitted, **306 excluded** as tracked/incumbent, **824 found but not category-confirmed**,
**1,706 rejected**. Those last two are shown in the UI, because an exclusion nobody can see is
indistinguishable from a bug.

### Where the sources disagree

A website is resolved from the product name, which can land on a same-named but unrelated company. So
the name-overlap bar is strict (≥0.7 — `helpcenter` vs the host label `help` is 0.4 and refused), and
generic names are not resolved at all. Where the directories place a product in a knowledge category
but its resolved homepage does not read as a competitor, that is recorded as a **source conflict** and
**neither reading is asserted**:

```
LiveAgent   3 directories say Contact Center KB · liveagent.com scores 0   ⚠ verify the domain
Shelf       2 directories say Knowledge Base    · shelf.im scores 0        ⚠ verify the domain
```

Products whose site could not be resolved show **"not assessed"**, never threat 0 — a missing
assessment is not a low threat.

## Daily monitoring

`npm run digest` runs both collectors, diffs against everything already reported, and summarises
**only what is new or materially changed**. A product already reported is not repeated — it is
counted, not listed. Verified: a second run in the same day reports `0 new, 116 already reported`.

**Email delivery is not configured.** The digest is generated and stored under `data/digests/` either
way, and the dashboard says so. To enable it, add to `.env`:

```
SMTP_HOST=smtp.office365.com   # Microsoft 365; needs SMTP AUTH enabled on the account
SMTP_PORT=587
SMTP_USER=<sending account>
SMTP_PASS=<password or app password>
SMTP_FROM=<sending address>
DIGEST_TO=surya.venkatasubramanian@kovai.co
```

The SMTP client is built in (`collectors/lib/mailer.js`, ~200 lines, no dependency), supports implicit
TLS on 465 and STARTTLS on 587, verifies certificates, and dot-stuffs message bodies.

For an unattended daily run that survives reboot, `npm run digest:schedule` prints the
`schtasks` command — the resident loop only runs while the process is alive.

## Known coverage limits

These are surfaced **in the UI**, next to the affected numbers, not buried here.

- **DataForSEO balance bounds AI Visibility.** All six surfaces work; a full probe costs ~$0.18 and
  the account holds ~$0.48 at the time of writing. When the budget guard stops a call the surface
  reports *not checked — budget*, which is not an absence. Cached prompts are free.
- **No Bright Data zone**, so the `/request` API (arbitrary-URL fetching, Web Unlocker) is unavailable.
  This no longer blocks AI Visibility — DataForSEO covers it — but it does block using Bright Data for
  general page fetching.
- **NewsAPI now returns 1 total result for "Document360"** (measured 2026-09-01, down from double
  digits). The developer plan also caps retrieval at page 1 and returns only a ~200-char content
  snippet. Its real contribution to the dataset is small.
- **Citation product tags come from each citation's title and domain only** — the cited pages are not
  fetched, so a citation with no tag reads *products undetermined*, not "mentions nothing".
- **The LinkedIn dataset has no keyword discovery**, so keyword coverage is bounded by how many
  `linkedin.com/posts` URLs a web search can surface, and LinkedIn is partially de-indexed. A keyword
  returning no URLs means *"not found by search"*, not *"no such post exists"*.

- **Google News RSS no longer exposes publisher URLs.** Measured 2026-08-10: `<link>` and `<guid>` are
  opaque `news.google.com/rss/articles/CBMi…` tokens, following one returns a 578 KB JS interstitial
  with no meta-refresh or external href, and the token is not a decodable URL. Only
  `<source url="…">` is real. So this source is treated as a **lead** (publisher + title + exact date)
  and resolved to an article URL via SearXNG; unresolvable leads are **dropped**, never stored as dead
  redirects. *(The previous version stored those redirects — one shipped record had domain
  `news.google.com`.)*
- **GDELT covers ~90 days.** The 365-day range is thinner for news as a result.
- **YouTube RSS returns only ~15 uploads.** Where a whole feed falls inside the window, video counts
  are a **floor, not a total**, and the UI says so.
- **GitBook, Guru and KnowledgeOwl publish no discoverable RSS feed** (8, 6 and 9 candidate paths
  probed plus `<head>` autodiscovery). Their Blogs coverage depends on SearXNG/GDELT discovery.
- **LinkedIn and X via SearXNG are search-index floors**, not totals — engines index a fraction of posts.
- **Undated records sit outside every date range.** They are counted separately, and there is an
  explicit "include undated" toggle so they are never silently mixed into a "last 30 days" figure.

## Name disambiguation

Two tracked products are named after ordinary English words. Without handling, *"a confluence of
factors"* and *"SEO guru"* would inflate share-of-voice — a quiet inaccuracy that makes the dashboard
useless for a decision. So `confluence` and `guru` additionally require corroborating product context
and reject known false-positive phrases:

```
PASS [confluence] "Atlassian Confluence is a wiki for team documentation."     → matched, ctx: atlassian
PASS [confluence] "The project failed due to a confluence of factors."        → rejected
PASS [guru]       "Guru is a knowledge management platform..."                → matched, ctx: knowledge management
PASS [guru]       "Ask any SEO guru and they will tell you the same."         → rejected
```

Configured in [config/brands.json](config/brands.json) (`require_context`, `negative_context`).

---

## Project structure

```
├─ server.js                     /api/data · /api/audit · /api/status
├─ config/brands.json            the 7 products; every endpoint proven by fetching it
├─ collectors/
│  ├─ collect.js                 runner — orchestrates adapters, writes store/coverage.json
│  ├─ reverify-legacy.js         re-verifies the old snapshot against the current gate
│  ├─ resolve-feeds.js           discovers + proves blog/YouTube endpoints
│  ├─ setup-python.js            installs the Python sidecar
│  ├─ build.js                   verified store → data/*.json
│  ├─ lib/                       fetch · verify · brands · record · pipeline · store · python
│  ├─ adapters/                  blogfeed · youtube · hackernews · googlenews · gdelt · searxng · linkedin · x_twikit
│  ├─ claude/                    queue (sentiment) · ai-visibility · recommend
│  ├─ python/                    x_collect.py · linkedin_collect.py · requirements.txt
│  ├─ searxng/                   docker-compose.yml · settings.yml (JSON enabled)
│  └─ store/                     the evidence store + run logs + audit trails
├─ data/                         what the dashboard renders (+ audit.json)
└─ public/                       frontend (no build step, no framework)
```

`collectors/store/mentions.json` is the source of truth. It is append-and-merge keyed by
(brand, channel, canonical URL), so re-running never duplicates a mention and never discards a prior
classification unless the page content hash changed.

---

## What changed from v1, and why

| v1 behaviour | v2 |
|---|---|
| `30/90/365` presets returned **everything** (`dateCutoff` returned `null`); `7d`/`14d` returned **0** because 46 of 66 mentions had no date | Real buckets computed from verified dates: **19 / 49 / 105 / 290**. Undated records excluded and counted separately |
| `meta.from` hardcoded to a date 8 mentions predated, and used as the custom-range `min` | Computed from the actual earliest verified date |
| Sentiment from a single unreviewed LLM pass, no evidence | Claude classifies from a verbatim excerpt and must quote it; unclassified stays unclassified |
| 45/45 signal recommendations had a title that was a prefix of their own body; "evidence" was unlinked prose | Every recommendation cites resolvable record ids and renders clickable sources with excerpts; prefix-titles are rejected |
| Refresh button always toasted "Up to date" without calling anything; `/api/refresh` existed but was never called | Removed. Collection is an explicit command with a printed coverage report |
| "vs 24 brands" hardcoded; AI share chart locked to 5 brands; sentiment column read `d360_sentiment` for every brand | All 7 products measured per prompt, computed from verified answer text |
| A `lh3.googleusercontent.com` image URL stored as a "Confluence mention" | Structural rejection of asset hosts, trackers and unresolved aggregator tokens |
| **New Players** tab | **Removed.** Its funding figures and first-seen dates were unverifiable LLM output with no fetched evidence, which the accuracy requirement rules out. Re-adding it needs a real funding source (Crunchbase/press releases) behind the same gate |

The legacy snapshot was **re-verified rather than trusted or discarded**: of 67 old mentions, **45 passed**
the current gate and were promoted; the rest are in `store/legacy-rejected.json` with reasons. Legacy
sentiment was dropped for all survivors — it carried no evidence excerpt and could not be audited.

---

## Current state

Run `npm start` and the console prints live integrity counts. As built:

- **303 verified records** across 7 products — 294 with a proven date, 243 with a confirmed live link
- **AI visibility measured** on 10 buyer prompts for all 7 products (Document360: 90% share, median rank 5)
- **12 recommendations**, all evidence-cited, 0 rejected
- **27 of 303 sentiment-classified** — the rest are queued; run `/refresh-intel` to continue
- **Dormant:** LinkedIn, X (no credentials) · SearXNG (not running) · GDELT (rate-limited from this IP)

The **Sources & Integrity** tab in the dashboard shows all of this, plus every excluded record and its
rejection reason.
