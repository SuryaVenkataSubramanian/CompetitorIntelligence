# Provider audit, the A–K scan, and the open-source landscape

Run the audit yourself: `npm run audit:providers` (~2 min, no billable calls).
Machine-readable output lands in `collectors/store/provider-audit.json`.

---

## 1. Why an audit and not just a health check

`npm run api:health` answers *is it up right now*. That is not the question that
accumulates debt. This audit grades every provider on four axes, in order,
because a failure at any level makes the ones below it irrelevant:

| Axis | Question |
|---|---|
| **Configured** | is a credential present at all? |
| **Authenticates** | does the credential still work? |
| **Funded** | is there quota or balance left to actually call it? |
| **Valuable** | does it return something no cheaper source already gives us? |

The fourth is the one that gets skipped. **NewsAPI passed the first three and
failed the fourth** — it authenticated, answered HTTP 200, and returned the same
single result that free Google News RSS returns for the same brand. An
integration that is up and adds nothing is technical debt wearing a green tick.

---

## 2. What was removed, and on what evidence

Every verdict came from a call through the **adapter's own code path**, not a
hand-written probe. That distinction mattered: two earlier drafts of this audit
reported wrong verdicts because they guessed at endpoints — `api.octolens.com`
returned a Vercel 404, and an invented Bright Data payload returned
`validation_error`. Both were facts about my guesses, not about the provider.

| Provider | Evidence | Verdict |
|---|---|---|
| **Octolens** | Key is **valid**. API answers **HTTP 403 — API access is not available on your current plan**. | Removed. No call protocol exists to fix in code. |
| **NewsAPI** | Authenticates. Returns **1 result** where free Google News RSS returns the same. Developer plan caps retrieval at page 1 and truncates content to ~200 chars. | Removed. Up, and contributing nothing. |
| **Bright Data** | `/status` answers **HTTP 200**. The scraper **trigger** every adapter depended on fails with **"Customer is not active"**. | Removed. Reading works; collecting does not. |
| `adapters/x_twikit.js` | Drove a real X account with a username and password. **Never collected once.** | Deleted. |
| `adapters/linkedin.js` | Needed a `li_at` session cookie. Dormant from the day it was written. | Deleted. |
| `adapters/x-brightdata.js` | Worked for one afternoon. Profile-only — no keyword search, so it could never see a stranger complaining about us. | Deleted. |
| `adapters/linkedin-brightdata.js` | Dark since the account suspended. | Deleted. |

**Nothing was lost.** LinkedIn is served by SerpAPI's `site:` query, X by
twitterapi.io, news by Google News RSS. Historical records collected by the
removed adapters remain in the store and still render — they are simply no
longer added to.

Files were **deleted rather than left unregistered**. An unregistered adapter is
a file people keep reading, re-enabling and re-debugging; git history is the
right place for code that cannot run. A test now asserts the removal is complete
and that nothing still `require()`s a removed module.

### Still configured, and why

| Provider | Unique value | State |
|---|---|---|
| **DataForSEO** | The **only** source that measures ChatGPT / Claude / Gemini / Perplexity / AI Overview answers. Irreplaceable. | `$0.0519` — cannot fund one probe (`$0.1805`). **Recharge.** |
| **SerpAPI** | The **only** route to LinkedIn — it honours `site:`. DuckDuckGo refuses `site:` outright. | 239 searches left. Working. |
| **ScrapingBee** | The only route past review-directory bot walls **and** DuckDuckGo's block page from a datacentre IP. | 733 / 1000 credits. Working. |
| **ScrapeBadger** | Intended to carry bulk. It also *declines* bot walls with `422`, so it never covered the pages ScrapingBee is needed for. | **0 credits.** Value at zero credits: nil. |
| **twitterapi.io** | The only working route to X. | **−518 credits** — goes negative rather than stopping at zero. |
| **Windsor.ai** | First-party GA4: traffic that actually *arrived* from an AI assistant. | 1,213 AI sessions / 30d. Working. |
| **SearXNG** | Free, unmetered, and its IP is not the one DuckDuckGo blocked. | Optional. Not running locally. |

---

## 3. SearXNG is now a search endpoint, nothing more

It has two endpoints and that is all the code uses:

```
GET /search?q=<phrase>&format=json    results
GET /                                 is it alive
```

`adapters/searxng.js` went from **308 lines to 119**. It was building per-brand
query *plans* — five query angles, a page multiplier, a channel matrix, 67
queries per brand, ~3,600 raw candidates each — plus a hand-rolled backoff for
the `Suspended: too many requests` that inevitably followed around query 40.

Everything it was computing — which channel a result belongs to, whether the
brand is really mentioned, whether the date is real — is already done downstream
by `lib/pipeline.js`, on every source, once. Doing it there meant a second,
divergent copy of that logic, and it meant SearXNG failing took six channels
with it.

**One phrase per brand, one page, one parse.** If a wider sweep is wanted, that
is a scheduling decision, not a reason to build a query planner.

It is also now the **preferred** route for the web-search slot in
`lib/freshsources.js`: when it is up it replaces DuckDuckGo, which from this
network costs a ScrapingBee credit per query to get past a block page.

---

## 4. The A–K scan — measured, this run

All eleven answered. **A zero is not a failure** — the report distinguishes
"answered and had nothing" from "could not be asked", because those are
different facts that look identical in a count.

| | Source | Result | Note |
|---|---|---|---|
| A | Google News RSS | 2 candidates, 1.6s | Item links are now an **opaque server-side token**; a HEAD does not redirect and the base64 decodes to an internal id. Publisher is read from the feed's own `<source url>` instead. |
| B | Hacker News Algolia | 0, 1.3s | **Genuine zero.** Typo filter confirmed: unquoted *GitBook* returns *netbook* / *GifBook*, so every hit is post-filtered on a literal match. |
| C | GitHub Search | 17, 9.2s | Noise filter working: vendor repos, `[bot]` authors and path-only matches dropped. *Mintlify* matched 153 items in a week; ~3 mattered. |
| D | DuckDuckGo | 18, 22.6s | ⚠️ **Serves its block page as HTTP 202** — inside the success range — with 14KB and zero results. Routed through the scraping chain; SearXNG preferred when up. |
| E | YouTube `sp=EgIIAw%3D%3D` | 5, 2.1s | Parsed from `ytInitialData`. Occasional HTTP 302 reported as a gap. |
| F | Stack Exchange | 0, 4.0s | **Genuine zero.** Always gzips regardless of `Accept-Encoding` — `lib/fetch.js` grew a `gzip` option for it. |
| G | Mastodon | 0, 3.6s | **Genuine zero.** Low yield as expected; found 52 candidates on a wider sweep. |
| H | GDELT | 0, 57.5s | ⚠️ **HTTP 429.** Documented at 1 req/5s; measured 429s at 5.5s across 7 brands, so throttle raised to 8s. Bonus layer only. |
| I | Reddit RSS | 0, 0.1s | ⚠️ **HTTP 429 → self-disabled 24h**, exactly as designed. Never retried in a loop. Now has an **OAuth route** when a credential is stored. |
| J | Vendor status pages | 0, 3.0s | **Genuine zero** — no incidents in the window. |
| K | Alternatives aggregators | 0, 2.6s | **Genuine zero** — no page refreshed inside the window. |

---

## 5. Open-source landscape — what I found and what I'd actually adopt

### LinkedIn: nothing here changes the architecture

Every maintained open-source LinkedIn scraper wants a **session file**, and the
most popular — [`joeyism/linkedin_scraper`](https://github.com/joeyism/linkedin_scraper)
(~2.5k stars) — is now marked **inactive** on the community index. The
[awesome-linkedin-scrapers](https://github.com/The-Web-Scraping-Playbook/awesome-linkedin-scrapers)
maintenance table lists `JobSpy` and `eracle/linkedin` as active, both
job-focused rather than mention-focused.

The honest summary from that index: *"scraper failures typically stem from
infrastructure limitations rather than code"* — i.e. you are buying residential
proxies and CAPTCHA solving, not a library.

**Recommendation: keep SerpAPI's `site:` query.** It finds the posts, needs no
account, and costs one search per brand. An OSS scraper would add reactions and
commenter lists at the price of an account that LinkedIn may suspend.

### X: the working set is known, and so is its shelf life

`snscrape`, `Twint` and `ntscraper` are **dead**. Working as of 2026:
[`Scweet`](https://github.com/Altimis/Scweet), `twscrape`, `Twikit`, `Tweety`.

The catch is consistent across all four: *"all need residential proxies and a
logged-in account for full data, and all break every two to four weeks when X
rotates its guest tokens and GraphQL identifiers."*

**That 2–4 week figure is why the credential cadence defaults to 14 days.**

**Recommendation: keep twitterapi.io** (recharge it). A hosted API that someone
else keeps working through X's rotations is worth more than a library you
re-fix fortnightly.

### Web extraction: the one genuine upgrade available

[**Trafilatura**](https://github.com/adbar/trafilatura) — Apache 2.0, Python —
scores **F1 0.945** on the ScrapingHub article-extraction benchmark (181 pages,
hand-labelled), ahead of go-readability at 0.943 and **readability.js at 0.887**.

This project's `htmlToText` is hand-rolled. Trafilatura is measurably better at
exactly the job that determines evidence quality here: pulling the article text
out of a page without boilerplate. Caveat: it *"returns an empty string on React
SPAs"* — the fix is rendering first, which the scraping chain already does.

There is precedent for Python in this repo (`collectors/python/`,
`setup-python.js`), so it is adoptable.

**Recommendation: worth a spike**, scoped to the evidence-extraction step only.
Not done here — it changes every stored excerpt, so it deserves its own change
with a before/after diff on a sample.

[**Crawl4AI**](https://github.com/unclecode/crawl4ai) (~78k stars, local-first,
markdown output) is the strongest general crawler, but it overlaps what
`lib/scrape.js` already does with ScrapingBee. **Not recommended** — it would
replace a working chain rather than fill a gap.

---

## 6. Account-backed collection (`npm run social:status`)

Optional, opt-in, local-only. Designed around the fact that **this project has
tried it twice and deleted both attempts**.

| Rule | Why |
|---|---|
| **Local only** | Refuses to load on a serverless host. A personal cookie in a Vercel env var is readable by everyone with project access and appears in build logs. |
| **Never in git** | Vault lives in `~/.d360-competitive-intel/`, outside the repo. This repo is public. |
| **Encrypted at rest** | AES-256-GCM under a key derived from `SESSION_SECRET`, file mode `0600`. |
| **Never silent** | Every credential has an explicit expiry. Past it, the channel reports **STALE** — it does not report zero. |
| **Always optional** | Every channel has a keyless route. This only ever *adds* coverage. |
| **Tagged provenance** | Records carry `auth_backed: true` and the platform — never the credential value. |

That fourth rule is the one that matters. An expired session returns an **empty
feed, not an error** — so a collector using one reports "no mentions this week"
and looks perfectly healthy. That is precisely how the previous two attempts
failed, so expiry is enforced once, centrally, rather than trusted to each
caller.

```bash
npm run social:status
npm run social:login  -- --platform=reddit --value=<client_id>:<client_secret>
npm run social:logout -- --platform=x
```

**Reddit is the one worth configuring.** It is a *supported first-party API
credential* with published rate limits — not a borrowed identity — and anonymous
Reddit access has been blocked since May 2026, so it is the difference between a
Reddit channel and none. LinkedIn and X both already have working anonymous
routes, so their credentials buy less and risk more.

---

## Sources

- [5 Best Open-Source LinkedIn Scrapers on GitHub in 2026 — Scrapfly](https://scrapfly.io/blog/posts/best-linkedin-scrapers-github)
- [awesome-linkedin-scrapers — The Web Scraping Playbook](https://github.com/The-Web-Scraping-Playbook/awesome-linkedin-scrapers)
- [4 Best Open-Source X Scrapers on GitHub in 2026 — Scrapfly](https://scrapfly.io/blog/posts/best-twitter-scrapers-github)
- [Scweet — GitHub](https://github.com/Altimis/Scweet)
- [Best Open-Source Web Scraping Libraries in 2026 — Firecrawl](https://www.firecrawl.dev/blog/best-open-source-web-scraping-libraries)
- [Firecrawl vs Crawl4AI (2026) — Webfuse](https://www.webfuse.com/compare/firecrawl-vs-crawl4ai)
- [7 Best AI Web Scraping Tools (2026) — ScrapeOps](https://scrapeops.io/web-scraping-playbook/best-ai-web-scraping-tools/)
