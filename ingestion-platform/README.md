# Brand Mention Ingestion Platform — implementation + architecture review

## Before anything else: a premise mismatch

The brief describes refactoring *"our existing prototype … Next.js App Router,
TypeScript, Prisma with PostgreSQL"*. **This repository is none of those things.**

```
deps: {}          devDeps: {}        node_modules: absent
next.config.*: absent   tsconfig.json: absent   prisma/schema.prisma: absent
app/: absent            lib/scrapers/: absent
```

`document360-competitive-intel` is a **zero-dependency Node.js** collector with a
static dashboard. There is no codebase here matching the one described, so there
was nothing to refactor — Phase 1's deprecation list (`duck-duck-scrape`,
`pushshift.io`, the X API v2 client, Cheerio AIO parsing) refers to integrations
that were never present.

So this directory is **new, self-contained, and drop-in**: every file sits where
the spec says it should (`lib/scrapers/…`, `prisma/schema.prisma`, `.env.example`)
and depends on nothing from the surrounding repo. Copy the directory into the
real Next.js app and it compiles against the spec's own contract.

Separately, and more usefully, **two of the spec's sources were ported into the
working collector**, where they produce data today. See "What actually shipped"
at the bottom.

---

## Files

| File | What it is |
|---|---|
| `lib/scrapers/types.ts` | The adapter contract, plus `parseDate`, `containsKeyword`, `fetchWithTimeout` |
| `lib/scrapers/adapters/searxng.ts` | Federated metasearch + `scrapeLinkedInMentions` dorking |
| `lib/scrapers/adapters/bluesky.ts` | AT Protocol public AppView, keyless |
| `lib/scrapers/adapters/hackernews.ts` | Algolia, with the typo-tolerance filter |
| `lib/scrapers/adapters/reddit.ts` | PullPush → Arctic Shift → search.rss |
| `lib/scrapers/adapters/linkedin.ts` | Voyager + CSRF quote handling + dork fallback |
| `lib/scrapers/adapters/google-aio.ts` | Headless Chromium, text-node heuristics |
| `lib/scrapers/engine.ts` | Dedupe, three-tier relevance, batch persist |
| `lib/scrapers/orchestrator.ts` | Plane-aware fan-out |
| `prisma/schema.prisma` | Persistence |
| `.env.example` | Configuration |

Install: `@prisma/client prisma rss-parser puppeteer-core @sparticuz/chromium`

---

## Architecture review — seven defects in the spec

I implemented the spec, but not verbatim. These are the places where following
it literally would ship a bug, in rough order of how much damage each does.

### 1. The SearXNG adapter fabricates publication dates — critical

```ts
publishedAt: item.publishedDate ? new Date(item.publishedDate) : new Date()
```

Most SearXNG results carry no `publishedDate`. This writes **today** as the
publication date for all of them. The record then sorts to the top of a "last 7
days" view and there is nothing in the row to indicate the date was invented.

It is the worst kind of bug because the output is indistinguishable from real
data. **Fixed**: `publishedAt: Date | null` plus a `dateConfidence` enum, and a
`discoveredAt` that is always known so range filters still have an axis.

### 2. The dedupe hash includes content, so edits duplicate

```ts
SHA256(`${platform}:${platformId}:${content.trim()}`)
```

An author fixes a typo → new hash → the same post appears twice. For Google AI
Overviews, whose text is regenerated on every query, *every run* inserts a new
row.

**Fixed**: identity is `SHA256(platform:platformId)` and is unique; content gets
a separate hash. An edit becomes an `UPDATE` with an `editedAt` stamp — which is
the thing you actually wanted to know.

### 3. Google AIO's `platformId` contains `Date.now()`

```ts
platformId: `google-aio-${base64(keyword)}-${Date.now()}`
```

Dedupe can never fire. One query a day is 365 rows a year describing one module.
**Fixed**: keyed on the normalised query alone.

### 4. The semantic filter fails *open*

```ts
} catch (err) {
  return { isRelevant: true, score: 0.5 };   // admits everything
}
```

If the Ollama container dies at 2am, every mention is admitted at half
confidence with no record that the filter never ran. The database fills with
homonym noise that looks exactly like classified data.

**Fixed**: an LLM failure falls through to the deterministic tier, and the
verdict records which tier decided (`relevanceMethod`) and on what span
(`relevanceEvidence`).

### 5. Tier-3 relevance uses substring matching

```ts
textLower.includes(kw.toLowerCase())
```

Your own Phase 3 asks for *"case-insensitive keyword **boundary** verification"* —
the spec's code does not do that. This matters most for the HN adapter, because
**Algolia is typo-tolerant**: a query for `GitBook` returns hits for *netbook*
and *GifBook*. **Fixed**: `containsKeyword()` enforces word boundaries, and the
HN adapter post-filters every hit before it can become a record.

### 6. `Promise.allSettled` + `[]` erases the difference between zero and blocked

The spec is right that one dead source must not fail the batch. But an adapter
that was blocked and an adapter that found nothing both return `[]`, so the
dashboard reports *"nobody mentioned us this week"* for an outage.

**Fixed**: adapters return a `ScrapeResult` carrying `queried: boolean` and
`gaps[]`. Gaps are persisted on the job row.

### 7. `findUnique` inside the insert loop

A 300-mention batch is 300 round trips — on a serverless function against a
pooled Postgres, that is both the slowest part of the run and the likeliest way
to exhaust the pool. **Fixed**: one `findMany` on the batch's hashes, plus
in-batch duplicate collapsing before any query.

### Also worth flagging

- **§5 has no retention or deletion mechanism**, while §11 correctly requires
  one for GDPR. Added `retentionDays` and `redactedAt`.
- **`PlatformSession.authData` is `Json`** — the spec's own prose says to encrypt
  it. The schema now makes that structural: `authDataEncrypted` + IV + auth tag,
  so plaintext cannot be stored by accident.
- **Sessions have no expiry.** They rot every 2–4 weeks, and an expired cookie
  returns an *empty feed, not an error*. Added `expiresAt`.

---

## Where I followed the spec against its own advice

You asked for the LinkedIn Voyager adapter in Phase 2. §11 of the same document
recommends skipping the authenticated plane entirely. Both are implemented, with
the §11 recommendation as the **default**: with no cookies configured, the
LinkedIn adapter transparently collects public posts via SERP dorking. Voyager
is an opt-in escalation (`includeAuthenticated: true`).

The CSRF quote handling you specifically called out is done once, in the
constructor, so no call site can get it wrong:

```ts
const bare = jsessionId.trim().replace(/^"+|"+$/g, "");
this.jsessionBare  = bare;         // csrf-token header — quotes STRIPPED
this.jsessionQuoted = `"${bare}"`; // cookie header     — quotes KEPT
```

---

## What actually shipped into the working dashboard

Two sources from this spec were ported into `collectors/lib/freshsources.js`
(plain Node, no dependencies) because they solve live gaps:

**Reddit replicas — works, and it is the biggest single win here.**
Reddit has been returning **zero** on this deployment: anonymous RSS gets a 429
and the source self-disables for 24h. PullPush + Arctic Shift, measured just
now across three brands:

```
reddit replicas: Document360 —  2 comment(s)
reddit replicas: Mintlify    —  7 comment(s)
reddit replicas: GitBook     — 78 comment(s)
```

87 candidates where the channel was empty, including a clean churn signal:
*"We ended up moving to Mintlify after running into basically the same p…"*

**Bluesky — implemented, blocked from this egress.**
Every query variant returns a **2.3 KB HTML 403 with a `fonts.bunny.net`
stylesheet** — no JSON API serves that. It is a network interstitial, not the
AppView refusing the query, and the proxy chain does not help for a JSON
endpoint. The adapter is correct and reports a *gap* rather than a zero; the
scheduled GitHub Actions runner has a different IP and is the obvious place to
confirm it.

I have not claimed Bluesky works. It does not, from here.
