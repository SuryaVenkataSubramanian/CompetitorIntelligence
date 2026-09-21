/**
 * The last-7-days sweep: eleven keyless sources, queried live.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every metered provider this project depends on ran out or shut off within a
 * single week: Bright Data suspended, DataForSEO fell to $0.05, Octolens moved
 * API access behind a paid tier, twitterapi.io went to negative credits, and
 * SearXNG is a local Docker service that cannot run on a serverless host at
 * all. The dashboard's newest record was then 7-10 days old, and the "Last 7
 * days" filter showed a week-old week.
 *
 * A dashboard whose freshness depends on a billing balance is not a dashboard.
 * Everything here needs NO KEY and NO ACCOUNT, so the recent view keeps working
 * when every paid provider is dark. Metered providers still run — they are
 * better where they work — but they are now the bonus layer, not the floor.
 *
 * WHAT EACH SOURCE ACTUALLY DELIVERS, AS MEASURED
 * ----------------------------------------------
 * These notes are the reason each source is shaped the way it is. They are
 * failure modes observed on the wire, not guesses about the APIs.
 *
 *   googlenews_rss  The strongest news layer. One phrase per query: it does not
 *                   honour OR. Its item links are now an OPAQUE server-side
 *                   token that cannot be resolved to the publisher's URL, so
 *                   the publisher is read from the feed instead — see
 *                   publisherOf() for what was measured.
 *   hn_algolia      TYPO-TOLERANT, which silently poisons the data: an unquoted
 *                   "GitBook" returned hits for "netbook" and "GifBook". The
 *                   alias is quoted AND every hit is post-filtered on a literal
 *                   case-insensitive match. A zero-hit week is then a true zero.
 *   github          "Mintlify" matched 153 items in one week; about three
 *                   mattered. The rest were the vendor's own docs repo, bots,
 *                   and files whose PATH contained the alias (*.mintlify.app,
 *                   docs/*.mdx). All three classes are excluded explicitly.
 *   duckduckgo      Does NOT honour OR — it matched any word and returned
 *                   crypto and thesaurus pages. One phrase per query. Rate
 *                   limited after ~8 requests in 2 minutes, and it refuses
 *                   site: entirely, so site: queries never go here.
 *   youtube         The results page with the "this week" filter, parsed from
 *                   ytInitialData rather than the Data API, so no quota key.
 *   stackexchange   ALWAYS gzips, whatever Accept-Encoding says — which is why
 *                   lib/fetch.js grew a gzip option.
 *   mastodon        Hashtag timelines only, so low yield. Kept because it is
 *                   free and occasionally carries a developer complaint.
 *   gdelt           One request per 5s, and it returned zero for every tracked
 *                   brand in the test week despite a real press release. Bonus
 *                   layer only — never treated as coverage.
 *   reddit          Reddit blocked anonymous JSON in May 2026 and RSS may go
 *                   the same way. FEATURE-FLAGGED: probed once per run, and a
 *                   403/429 disables it for 24h. Never retried in a loop.
 *   statuspages     A vendor incident inside the window is a reliability item
 *                   and a genuine competitive signal.
 *   alternatives    openalternative.co / alternativeto.net refreshed both the
 *                   Mintlify and GitBook pages in the test week. A refresh
 *                   inside the window means buyers are actively comparing.
 *
 * EVERY CANDIDATE CARRIES ITS OWN EVIDENCE. Nothing here asserts a mention it
 * cannot quote; the shared pipeline then re-confirms the alias appears in the
 * text before anything is stored.
 */
const path = require("path");
const { fetchUrl, fetchJson } = require("./fetch");
const { brand, brandOrder } = require("./brands");
const { toIsoDate, htmlToText, decodeEntities, domainOf } = require("./verify");
const { readJson, writeJson, STORE_DIR } = require("./store");

const STATE_FILE = path.join(STORE_DIR, "freshsources-state.json");

/* ------------------------------------------------------------------ state */

function loadState() {
  const s = readJson(STATE_FILE, null) || {};
  return {
    google_redirects: s.google_redirects || {},
    disabled_until: s.disabled_until || {},
    disabled_reason: s.disabled_reason || {},
    updated_at: s.updated_at || null,
  };
}

/**
 * Persist the sweep's state. NEVER THROWS.
 *
 * MEASURED FAILURE: on Vercel this threw
 *   EROFS: read-only file system, open '/var/task/collectors/store/freshsources-state.json'
 * from the last line of sweep(), AFTER every source had been queried
 * successfully. The exception escaped, the request 500'd, and a complete set of
 * collected mentions was thrown away because a cache file could not be written.
 *
 * lib/store.writeJson now redirects to os.tmpdir() on a read-only filesystem and
 * returns a receipt rather than throwing, but the guarantee is restated here
 * because this call site is the one that cost real data.
 *
 * WHAT IS IN THIS FILE, AND WHAT LOSING IT COSTS. On a serverless host /tmp is
 * per-instance and is discarded on a cold start, so both of these reset:
 *
 *   disabled_until.reddit    the 24h backoff after Reddit answers 403/429.
 *                            Reset early, the next cold start re-probes Reddit
 *                            sooner than intended. One extra refused request,
 *                            then it backs off again. Tolerable.
 *   last_linkedin_sweep      the 20h pacing that makes SerpAPI's 250
 *                            searches/month last. Reset early, an unattended
 *                            sweep may spend 7 searches sooner than planned.
 *                            Worth knowing, because the quota is the binding
 *                            constraint on the LinkedIn channel.
 *   google_redirects         a resolution cache. Losing it costs nothing but
 *                            repeated work.
 *
 * Neither reset corrupts data or fabricates anything — they cost requests, not
 * accuracy. Making them durable needs a database, and this project has none by
 * design. If the SerpAPI spend becomes a problem the honest fix is a scheduled
 * runner with a real filesystem (.github/workflows/refresh.yml), not a
 * datastore added for one integer.
 */
function saveState(s) {
  s.updated_at = new Date().toISOString();
  // The redirect cache is unbounded otherwise; 3000 entries is months of news.
  const keys = Object.keys(s.google_redirects || {});
  if (keys.length > 4000) {
    const trimmed = {};
    for (const k of keys.slice(-3000)) trimmed[k] = s.google_redirects[k];
    s.google_redirects = trimmed;
  }

  try {
    const receipt = writeJson(STATE_FILE, s);
    if (!receipt.ok) {
      console.warn(
        "  ! sweep state not saved (" + receipt.error + "). The sweep's RESULTS are " +
        "unaffected; only the backoff and pacing counters were lost."
      );
    }
    return receipt;
  } catch (e) {
    // writeJson is contracted not to throw, but this call site must survive it
    // even if that contract is ever broken.
    console.warn("  ! sweep state not saved: " + String(e && e.message || e));
    return { ok: false, persisted: false, error: String(e && e.message || e) };
  }
}

function isDisabled(state, id) {
  const until = state.disabled_until && state.disabled_until[id];
  return !!(until && Date.parse(until) > Date.now());
}

function disableFor(state, id, hours, reason) {
  state.disabled_until[id] = new Date(Date.now() + hours * 3600e3).toISOString();
  state.disabled_reason[id] = reason;
}

/* ----------------------------------------------------------------- helpers */

/**
 * Does this text literally contain the alias?
 *
 * Deliberately stricter than a substring test: "Guru" must not match "gurus"
 * or "Gurugram". And deliberately LOOSER than lib/brands.matchBrand, which
 * additionally requires disambiguating context. Context is the shared
 * pipeline's job; this is only the cheap pre-filter that stops a typo-tolerant
 * search engine's near-miss from ever becoming a record.
 */
function literalAlias(text, alias) {
  if (!text || !alias) return null;
  const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const re = new RegExp("(^|[^A-Za-z0-9])(" + esc + ")([^A-Za-z0-9]|$)", "i");
  const m = re.exec(text);
  return m ? m[2] : null;
}

/** The first alias of a brand that literally appears in the text. */
function firstAliasIn(text, brandId) {
  for (const a of brand(brandId).aliases) {
    const hit = literalAlias(text, a);
    if (hit) return hit;
  }
  return null;
}

function withinWindow(iso, sinceMs) {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= sinceMs && t <= Date.now() + 36e5;
}

function clip(s, n = 1200) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) : t;
}

/** Pull one RSS/Atom tag out of an item block. */
function tagOf(block, name) {
  const m = new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">", "i").exec(block);
  if (!m) return null;
  return decodeEntities(m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "")).trim();
}

/* ============================================================ A. Google News */

/**
 * Google News RSS. `when:Nd` is server-side, so the window is enforced by
 * Google rather than by us discarding most of what came back.
 */
async function googleNewsRss({ brands, sinceMs, sinceDays, state, log }) {
  const candidates = [];
  const gaps = [];
  const days = Math.max(1, Math.min(30, sinceDays));

  for (const id of brands) {
    const b = brand(id);
    const alias = b.aliases[0];
    const url =
      "https://news.google.com/rss/search?q=" +
      encodeURIComponent('"' + alias + '" when:' + days + "d") +
      "&hl=en-US&gl=US&ceid=US:en";

    const r = await fetchUrl(url, { retries: 1, timeout: 30000 });
    if (!r.ok) { gaps.push({ brand_id: id, reason: "Google News RSS HTTP " + r.status }); continue; }

    const items = String(r.body).split(/<item>/i).slice(1);
    let kept = 0;
    for (const raw of items) {
      const title = tagOf(raw, "title");
      const link = tagOf(raw, "link");
      const pub = tagOf(raw, "pubDate");
      const source = tagOf(raw, "source");
      const desc = htmlToText(tagOf(raw, "description") || "");
      if (!title || !link) continue;

      const text = [title, desc].filter(Boolean).join(". ");
      // Google matches loosely inside article bodies we cannot see. Without the
      // alias in the title or snippet there is nothing to quote as evidence, so
      // there is nothing to store.
      const matched = firstAliasIn(text, id);
      if (!matched) continue;

      const published = toIsoDate(pub);
      if (published && !withinWindow(published, sinceMs)) continue;

      const publisherDomain = publisherOf(raw);
      candidates.push({
        brand_id: id,
        channel: "web",
        url: link,
        title: title,
        published_at: published,
        date_method: published ? "googlenews:pubDate" : null,
        source_text: text,
        source_verified: true,
        source_adapter: "googlenews_rss",
        discovered_via: url,
        author: source || null,
        extra: {
          news_source: source || null,
          // The link is a Google News redirect. It resolves correctly in a
          // browser, so it is a working link to the mention; what it does NOT
          // carry is the publisher, which is why that is recorded separately
          // rather than inferred from the URL.
          link_is_google_redirect: true,
          publisher: source || null,
          publisher_domain: publisherDomain,
          matched_alias: matched,
        },
      });
      kept++;
    }
    log("      google news: " + b.name + " — " + kept + " item(s)");
  }
  return { candidates, gaps };
}

/**
 * The publisher behind a Google News item.
 *
 * MEASURED, AND THE REASON THERE IS NO URL RESOLUTION HERE: Google News item
 * links are now an opaque server-side token (`/rss/articles/CBMi...`). A HEAD
 * does not redirect, a GET answers HTTP 200 with a JavaScript shim, and the
 * base64 inside the token decodes to an internal identifier with no URL in it.
 * The only documented way through is a batchexecute RPC, which is undocumented,
 * unstable and one deploy from breaking silently.
 *
 * So the redirect is kept as the link — it resolves correctly in a browser, so
 * it genuinely reaches the mention — and the publisher is read from the feed's
 * own `<source url="...">` attribute instead. That is a fact the feed states,
 * rather than one inferred from a URL we could not resolve. Spending a request
 * per item to rediscover that it cannot be resolved would be pure cost.
 */
function publisherOf(itemBlock) {
  const m = /<source[^>]+url="([^"]+)"/i.exec(itemBlock);
  if (!m) return null;
  return domainOf(decodeEntities(m[1]));
}

/* ========================================================== B. Hacker News */

async function hnAlgolia({ brands, sinceMs, log }) {
  const candidates = [];
  const gaps = [];
  const cutoff = Math.floor(sinceMs / 1000);

  for (const id of brands) {
    const b = brand(id);
    const alias = b.aliases[0];
    const url =
      "https://hn.algolia.com/api/v1/search_by_date?query=" +
      encodeURIComponent('"' + alias + '"') +
      "&tags=(story,comment)&numericFilters=created_at_i>" + cutoff + "&hitsPerPage=100" +
      "&restrictSearchableAttributes=comment_text,story_text,title";

    const r = await fetchJson(url, { retries: 1, timeout: 30000 });
    if (!r.ok || !r.json) { gaps.push({ brand_id: id, reason: "HN Algolia HTTP " + r.status }); continue; }

    let kept = 0;
    let typoDropped = 0;
    for (const h of r.json.hits || []) {
      const text = [h.title, h.story_title, h.story_text, h.comment_text]
        .filter(Boolean).map(htmlToText).join(". ");
      // THE TYPO FILTER. Algolia's prefix/typo tolerance returned "netbook" and
      // "GifBook" for GitBook. Without this, every such near-miss becomes a
      // permanent record attributed to a brand that was never mentioned.
      const matched = firstAliasIn(text, id);
      if (!matched) { typoDropped++; continue; }

      const target = h.url || ("https://news.ycombinator.com/item?id=" + h.objectID);
      candidates.push({
        brand_id: id,
        channel: "web",
        url: target,
        title: h.title || h.story_title || null,
        published_at: toIsoDate(h.created_at),
        date_method: "hn:created_at",
        source_text: clip(text, 2000),
        source_verified: true,
        source_adapter: "hn_recent",
        discovered_via: url,
        author: h.author || null,
        extra: {
          hn_object_id: h.objectID,
          hn_points: h.points == null ? null : h.points,
          hn_thread: "https://news.ycombinator.com/item?id=" + (h.story_id || h.objectID),
          is_comment: !!h.comment_text,
          matched_alias: matched,
        },
      });
      kept++;
    }
    log("      hacker news: " + b.name + " — " + kept + " kept, " + typoDropped + " typo-tolerant near-miss(es) dropped");
  }
  return { candidates, gaps };
}

/* =============================================================== C. GitHub */

/** Repos that are the vendor's own, where every hit is self-reference. */
const GITHUB_OWN_REPOS = {
  mintlify: ["mintlify/docs", "mintlify/starter", "mintlify/mint"],
  gitbook: ["GitbookIO/gitbook", "GitbookIO/integrations"],
  document360: ["document360/document360"],
  confluence: [],
  guru: [],
  bloomfire: [],
  knowledgeowl: [],
};

/**
 * The alias appearing only inside a URL or a file path is not a mention.
 * Strip both, then re-test: if it no longer matches, it was never prose.
 */
function aliasOnlyInPath(text, alias) {
  const bare = String(text).replace(
    /(?:https?:\/\/\S+|\S+\.(?:mintlify\.app|gitbook\.io)\S*|[\w./-]*\.(?:mdx?|json|ya?ml|ts|tsx|js|jsx|toml|lock)\b)/gi,
    " "
  );
  return !literalAlias(bare, alias);
}

async function githubSearch({ brands, sinceMs, log }) {
  const candidates = [];
  const gaps = [];
  const sinceDate = new Date(sinceMs).toISOString().slice(0, 10);

  for (const id of brands) {
    const b = brand(id);
    const alias = b.aliases[0];
    const excl = (GITHUB_OWN_REPOS[id] || []).map(r => " -repo:" + r).join("");
    const q = '"' + alias + '"' + excl + " created:>=" + sinceDate;
    const url = "https://api.github.com/search/issues?q=" + encodeURIComponent(q) +
      "&sort=created&order=desc&per_page=50";

    const r = await fetchJson(url, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      retries: 1, timeout: 30000,
    });
    if (r.status === 403 || r.status === 429) {
      gaps.push({ brand_id: id, reason: "GitHub search rate limit (10 search/min, 60 REST/hr unauthenticated)" });
      continue;
    }
    if (!r.ok || !r.json) { gaps.push({ brand_id: id, reason: "GitHub search HTTP " + r.status }); continue; }

    let kept = 0;
    let noise = 0;
    for (const it of r.json.items || []) {
      const author = (it.user && it.user.login) || "";
      // Dependabot and friends open hundreds of near-identical issues.
      if (/\[bot\]$/i.test(author)) { noise++; continue; }

      const text = [it.title, it.body].filter(Boolean).join("\n");
      const matched = firstAliasIn(text, id);
      if (!matched) { noise++; continue; }
      // "Mintlify" matched 153 items in a week and about three mattered: the
      // rest were a dependency string, a deploy URL or an .mdx path. A mention
      // has to be in prose.
      if (aliasOnlyInPath(text, matched)) { noise++; continue; }

      candidates.push({
        brand_id: id,
        channel: "web",
        url: it.html_url,
        title: it.title || null,
        published_at: toIsoDate(it.created_at),
        date_method: "github:created_at",
        source_text: clip(htmlToText(text), 2000),
        source_verified: true,
        source_adapter: "github_recent",
        discovered_via: url,
        author: author || null,
        extra: {
          github_repo: (it.repository_url || "").replace("https://api.github.com/repos/", "") || null,
          github_state: it.state || null,
          github_comments: it.comments == null ? null : it.comments,
          is_pull_request: !!it.pull_request,
          matched_alias: matched,
        },
      });
      kept++;
    }
    log("      github: " + b.name + " — " + kept + " kept, " + noise + " self-reference/bot/path-only dropped");
  }
  return { candidates, gaps };
}

/* =========================================================== D. DuckDuckGo */

/**
 * DuckDuckGo HTML with the past-week filter.
 *
 * ONE PHRASE PER QUERY, ALWAYS. It does not honour OR — an OR query matched any
 * single word and returned crypto and thesaurus pages. And never a site:
 * operator: DDG refuses those outright, returning an empty page that reads as
 * "no results" rather than as "unsupported".
 */
async function duckduckgo({ brands, state, log }) {
  const candidates = [];
  const gaps = [];
  const scrape = require("./scrape");
  const searxng = require("./searxng-client");

  /* SEARXNG FIRST, WHEN IT IS UP.
   *
   * Both routes answer the same question — "what does the open web say about
   * this brand this week" — and SearXNG answers it better for three reasons
   * that are all about cost rather than quality:
   *
   *   - it is free and unmetered, where DuckDuckGo from this network needs a
   *     ScrapingBee credit per query to get past the block page;
   *   - its instance IP is not the one DuckDuckGo has flagged;
   *   - it aggregates several engines behind one parser, so a single engine
   *     going down degrades the result instead of emptying it.
   *
   * It is OPTIONAL, not required. It is a local service and cannot run on a
   * serverless host, so when it is absent this falls through to DuckDuckGo
   * exactly as before. Probed ONCE per sweep, not once per brand. */
  let searxUp = false;
  try {
    const probe = await searxng.probe();
    searxUp = probe.ok;
    if (searxUp) log("      web search: using SearXNG (free, unblocked) instead of DuckDuckGo");
  } catch (e) { searxUp = false; }

  if (searxUp) {
    for (const id of brands) {
      const b = brand(id);
      const q = '"' + b.aliases[0] + '"';
      const r = await searxng.search(q, { days: 7 });
      if (!r.ok) {
        gaps.push({ brand_id: id, reason: "SearXNG query failed: " + String(r.error).slice(0, 110) });
        continue;
      }
      let kept = 0;
      for (const hit of r.results || []) {
        if (!hit.url) continue;
        const text = [hit.title, hit.content].filter(Boolean).join(". ");
        const matched = firstAliasIn(text, id);
        if (!matched) continue;
        candidates.push({
          brand_id: id,
          channel: null,
          url: hit.url,
          title: hit.title || null,
          // SearXNG has no reliable per-result date; the pipeline proves one
          // from the page or the record stays undated.
          published_at: null,
          date_method: null,
          source_text: text,
          source_verified: true,
          source_adapter: "searxng_week",
          discovered_via: "searxng: " + q,
          author: null,
          extra: { matched_alias: matched, searxng_engine: hit.engine || null, fetched_via: "searxng" },
        });
        kept++;
      }
      log("      web search: " + b.name + " — " + kept + " result(s) via SearXNG");
    }
    return { candidates, gaps };
  }

  for (const id of brands) {
    const b = brand(id);
    const alias = b.aliases[0];
    const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent('"' + alias + '"') + "&df=w";

    /* DIRECT FETCHES OF DDG DO NOT WORK FROM THIS NETWORK, AND THE FAILURE IS
     * SILENT. Measured: HTTP 202 — inside the success range — with 14KB of
     * "unusual traffic" markup and zero results, which every naive parser reads
     * as a genuine empty week. The same query through the scraping chain
     * returned 36KB and 10 real results.
     *
     * So it goes through lib/scrape.js, which is the one place that knows how
     * to get past a wall and reports which route it used. The direct attempt is
     * skipped there (DIRECT_HOPELESS), so no time is spent rediscovering this
     * per brand per run. */
    const r = await scrape.fetchPage(url, { log });
    if (!r.ok) {
      gaps.push({
        brand_id: id,
        reason: "DuckDuckGo unreachable: " + String(r.error || "HTTP " + r.status).slice(0, 140),
      });
      continue;
    }
    if (/anomaly|unusual traffic/i.test(r.body) && r.bytes < 20000) {
      gaps.push({
        brand_id: id,
        reason: "DuckDuckGo served its block page (HTTP " + r.status + ") through every available route — " +
          "reported as a gap rather than stored as zero, because it is the difference between " +
          "'nothing was said' and 'we could not look'",
      });
      continue;
    }

    const blocks = String(r.body).split(/<div class="result[\s"]/i).slice(1);
    let kept = 0;
    for (const blk of blocks) {
      const am = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(blk);
      if (!am) continue;
      let href = decodeEntities(am[1]);
      // DDG wraps results in /l/?uddg=<encoded>
      const ud = /[?&]uddg=([^&]+)/.exec(href);
      if (ud) { try { href = decodeURIComponent(ud[1]); } catch (e) { /* leave as-is */ } }
      if (!/^https?:\/\//i.test(href)) continue;

      const title = htmlToText(am[2]);
      const sm = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(blk);
      const snippet = sm ? htmlToText(sm[1]) : "";
      const text = [title, snippet].filter(Boolean).join(". ");
      const matched = firstAliasIn(text, id);
      if (!matched) continue;

      candidates.push({
        brand_id: id,
        channel: null,           // derived from the URL by the pipeline
        url: href,
        title: title || null,
        // df=w is DDG's own filter; it publishes no per-result date, so the
        // record carries none rather than a fabricated one.
        published_at: null,
        date_method: null,
        source_text: text,
        source_verified: true,
        source_adapter: "duckduckgo_week",
        discovered_via: url,
        author: null,
        extra: { ddg_window: "past week", matched_alias: matched, fetched_via: r.via },
      });
      kept++;
    }
    log("      duckduckgo: " + b.name + " — " + kept + " past-week result(s) via " + r.via);
  }
  return { candidates, gaps };
}

/* ============================================================== E. YouTube */

function ytText(n) {
  if (!n) return null;
  if (n.simpleText) return n.simpleText;
  if (Array.isArray(n.runs)) return n.runs.map(x => x.text || "").join("");
  return null;
}

/** sp=EgIIAw%3D%3D is YouTube's "uploaded this week" filter. */
async function youtubeWeek({ brands, log }) {
  const candidates = [];
  const gaps = [];

  for (const id of brands) {
    const b = brand(id);
    const alias = b.aliases[0];
    const url = "https://www.youtube.com/results?search_query=" +
      encodeURIComponent(alias) + "&sp=EgIIAw%253D%253D";

    const r = await fetchUrl(url, { retries: 1, timeout: 35000, maxBytes: 8 * 1024 * 1024 });
    if (!r.ok) { gaps.push({ brand_id: id, reason: "YouTube results HTTP " + r.status }); continue; }

    const m = /ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/.exec(r.body);
    if (!m) { gaps.push({ brand_id: id, reason: "YouTube markup changed — ytInitialData not found" }); continue; }
    let data = null;
    try { data = JSON.parse(m[1]); } catch (e) {
      gaps.push({ brand_id: id, reason: "YouTube ytInitialData did not parse" });
      continue;
    }

    const vids = [];
    (function walk(n) {
      if (!n || typeof n !== "object") return;
      if (n.videoRenderer) vids.push(n.videoRenderer);
      for (const k of Object.keys(n)) walk(n[k]);
    })(data);

    let kept = 0;
    for (const v of vids) {
      if (!v.videoId) continue;
      const title = ytText(v.title);
      const channel = ytText(v.ownerText) || ytText(v.longBylineText);
      const desc = (v.detailedMetadataSnippets || [])
        .map(s => ytText(s.snippetText)).filter(Boolean).join(" ");
      const text = [title, desc].filter(Boolean).join(". ");
      const matched = firstAliasIn(text, id);
      if (!matched) continue;

      candidates.push({
        brand_id: id,
        channel: "video",
        url: "https://www.youtube.com/watch?v=" + v.videoId,
        title: title || null,
        // publishedTimeText is relative ("3 days ago"); the sp filter already
        // bounds it to this week, and a relative string is not a date.
        published_at: null,
        date_method: null,
        source_text: text,
        source_verified: true,
        source_adapter: "youtube_week",
        discovered_via: url,
        author: channel || null,
        extra: {
          youtube_video_id: v.videoId,
          youtube_channel: channel || null,
          published_relative: ytText(v.publishedTimeText) || null,
          views_text: ytText(v.viewCountText) || null,
          window: "uploaded this week",
          matched_alias: matched,
        },
      });
      kept++;
    }
    log("      youtube: " + b.name + " — " + kept + " video(s) uploaded this week");
  }
  return { candidates, gaps };
}

/* ======================================================== F. Stack Exchange */

async function stackExchange({ brands, sinceMs, log }) {
  const candidates = [];
  const gaps = [];
  const from = Math.floor(sinceMs / 1000);
  const sites = ["stackoverflow", "softwareengineering"];

  for (const id of brands) {
    const b = brand(id);
    const alias = b.aliases[0];
    let kept = 0;

    for (const site of sites) {
      const url =
        "https://api.stackexchange.com/2.3/search/advanced?q=" + encodeURIComponent(alias) +
        "&fromdate=" + from + "&site=" + site +
        "&filter=withbody&pagesize=50&order=desc&sort=creation";

      // Stack Exchange gzips every response regardless of Accept-Encoding.
      const r = await fetchJson(url, { retries: 1, timeout: 30000, gzip: true });
      if (!r.ok || !r.json) { gaps.push({ brand_id: id, reason: "Stack Exchange (" + site + ") HTTP " + r.status }); continue; }
      if (r.json.error_message) { gaps.push({ brand_id: id, reason: "Stack Exchange: " + r.json.error_message }); continue; }

      for (const q of r.json.items || []) {
        const text = [decodeEntities(q.title || ""), htmlToText(q.body || "")].filter(Boolean).join(". ");
        const matched = firstAliasIn(text, id);
        if (!matched) continue;

        candidates.push({
          brand_id: id,
          channel: "web",
          url: q.link,
          title: decodeEntities(q.title || "") || null,
          published_at: q.creation_date ? new Date(q.creation_date * 1000).toISOString() : null,
          date_method: "stackexchange:creation_date",
          source_text: clip(text, 2000),
          source_verified: true,
          source_adapter: "stackexchange",
          discovered_via: url,
          author: (q.owner && q.owner.display_name) || null,
          extra: {
            se_site: site,
            se_score: q.score == null ? null : q.score,
            se_answered: !!q.is_answered,
            se_tags: q.tags || [],
            matched_alias: matched,
          },
        });
        kept++;
      }
    }
    log("      stack exchange: " + b.name + " — " + kept + " question(s)");
  }
  return { candidates, gaps };
}

/* ============================================================= G. Mastodon */

const MASTODON_HOSTS = ["mastodon.social", "fosstodon.org", "hachyderm.io"];

async function mastodon({ brands, sinceMs, log }) {
  const candidates = [];
  const gaps = [];

  for (const id of brands) {
    const b = brand(id);
    const tag = b.aliases[0].toLowerCase().replace(/[^a-z0-9]/g, "");
    let kept = 0;

    for (const host of MASTODON_HOSTS) {
      const url = "https://" + host + "/api/v1/timelines/tag/" + encodeURIComponent(tag) + "?limit=40";
      const r = await fetchJson(url, { retries: 0, timeout: 20000 });
      if (!r.ok || !Array.isArray(r.json)) continue;   // an instance being down is not a coverage gap

      for (const st of r.json) {
        if (!withinWindow(st.created_at, sinceMs)) continue;
        const text = htmlToText(st.content || "");
        const matched = firstAliasIn(text, id);
        if (!matched) continue;

        candidates.push({
          brand_id: id,
          channel: "web",
          url: st.url || st.uri,
          title: null,
          published_at: toIsoDate(st.created_at),
          date_method: "mastodon:created_at",
          source_text: text,
          source_verified: true,
          source_adapter: "mastodon",
          discovered_via: url,
          author: (st.account && (st.account.display_name || st.account.acct)) || null,
          extra: {
            mastodon_host: host,
            reblogs: st.reblogs_count == null ? null : st.reblogs_count,
            favourites: st.favourites_count == null ? null : st.favourites_count,
            matched_alias: matched,
          },
        });
        kept++;
      }
    }
    if (kept) log("      mastodon: " + b.name + " — " + kept + " post(s)");
  }
  return { candidates, gaps };
}

/* ================================================================ H. GDELT */

async function gdeltRecent({ brands, sinceDays, log }) {
  const candidates = [];
  const gaps = [];
  const span = Math.max(1, Math.min(30, sinceDays)) + "d";

  for (const id of brands) {
    const b = brand(id);
    const url =
      "https://api.gdeltproject.org/api/v2/doc/doc?query=" +
      encodeURIComponent('"' + b.aliases[0] + '"') +
      "&mode=ArtList&timespan=" + span + "&format=json&maxrecords=75&sort=datedesc";

    const r = await fetchJson(url, { retries: 1, timeout: 40000 });
    if (!r.ok || !r.json) { gaps.push({ brand_id: id, reason: "GDELT HTTP " + r.status }); continue; }

    let kept = 0;
    for (const a of r.json.articles || []) {
      const matched = firstAliasIn(a.title || "", id);
      if (!matched) continue;
      candidates.push({
        brand_id: id,
        channel: "web",
        url: a.url,
        title: a.title || null,
        published_at: toIsoDate(a.seendate),
        date_method: "gdelt:seendate",
        source_text: a.title || null,
        source_verified: true,
        source_adapter: "gdelt_recent",
        discovered_via: url,
        author: a.domain || null,
        extra: { gdelt_domain: a.domain || null, gdelt_language: a.language || null, matched_alias: matched },
      });
      kept++;
    }
    if (kept) log("      gdelt: " + b.name + " — " + kept + " article(s)");
  }
  return { candidates, gaps };
}

/* =============================================================== I. Reddit */

/**
 * Feature-flagged, because Reddit blocked anonymous JSON access in May 2026 and
 * RSS is plausibly next. Probed ONCE per run; a 403 or 429 disables it for 24
 * hours and the sweep moves on. Never retried in a loop — retrying against a
 * source that has decided to block you is how an IP gets banned outright.
 */
/**
 * Reddit's OAuth route, used when a script-app credential is in the vault.
 *
 * WHY THIS IS THE ONE ACCOUNT-BACKED ROUTE WORTH HAVING
 * ----------------------------------------------------
 * The other two platforms need a scraped session cookie — a personal login,
 * against the platform's terms, breaking every 2-4 weeks. Reddit publishes a
 * SUPPORTED app credential with documented rate limits. It is a first-party
 * API key that happens to live in the same vault, not a borrowed identity.
 *
 * It also has the largest effect: anonymous Reddit access was blocked in May
 * 2026 and the RSS fallback now self-disables for 24h on the 403 it gets. So
 * this is the difference between a Reddit channel and no Reddit channel, where
 * LinkedIn and X both already have working anonymous routes.
 *
 * Returns null when no credential is stored, and the caller falls back to RSS.
 */
async function redditOAuthToken(log) {
  let social;
  try { social = require("./social-auth"); } catch (e) { return null; }

  const cred = social.get("reddit");
  if (!cred.ok) {
    // A STALE credential is reported, not silently skipped. An expired token
    // returns an empty listing rather than an error, which is exactly the
    // failure this project keeps having to fix.
    if (cred.state === "stale") log("      reddit: " + cred.reason);
    return null;
  }

  const [id, secret] = String(cred.value).split(":");
  if (!id || !secret) {
    log("      reddit: stored credential is not in <client_id>:<client_secret> form");
    return null;
  }

  const body = "grant_type=client_credentials";
  const r = await fetchJson("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(id + ":" + secret).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
      "User-Agent": "Document360-CompetitiveIntel/2.0 (internal research tool)",
    },
    body,
    retries: 1,
    timeout: 25000,
  });

  if (!r.ok || !r.json || !r.json.access_token) {
    log("      reddit: OAuth token request failed (HTTP " + r.status + ") — falling back to RSS");
    return null;
  }
  return r.json.access_token;
}

async function redditViaOAuth({ brands, sinceMs, token, log }) {
  const candidates = [];
  const gaps = [];

  for (const id of brands) {
    const b = brand(id);
    const url = "https://oauth.reddit.com/search?q=" +
      encodeURIComponent('"' + b.aliases[0] + '"') + "&sort=new&t=week&limit=100";

    const r = await fetchJson(url, {
      headers: {
        Authorization: "Bearer " + token,
        "User-Agent": "Document360-CompetitiveIntel/2.0 (internal research tool)",
      },
      retries: 1,
      timeout: 25000,
    });
    if (!r.ok || !r.json) {
      gaps.push({ brand_id: id, reason: "Reddit OAuth search HTTP " + r.status });
      continue;
    }

    let kept = 0;
    for (const child of (r.json.data && r.json.data.children) || []) {
      const d = child.data || {};
      const text = [d.title, d.selftext].filter(Boolean).join(". ");
      const matched = firstAliasIn(text, id);
      if (!matched) continue;
      const published = d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null;
      if (published && !withinWindow(published, sinceMs)) continue;

      candidates.push({
        brand_id: id,
        channel: "web",
        url: d.permalink ? "https://www.reddit.com" + d.permalink : d.url,
        title: d.title || null,
        published_at: published,
        date_method: "reddit:created_utc",
        source_text: clip(text, 2000),
        source_verified: true,
        source_adapter: "reddit_oauth",
        discovered_via: url,
        author: d.author || null,
        extra: {
          subreddit: d.subreddit || null,
          score: d.score == null ? null : d.score,
          num_comments: d.num_comments == null ? null : d.num_comments,
          matched_alias: matched,
          // Provenance: this record came through an account, and a reader
          // should be able to see that.
          auth_backed: true,
          auth_platform: "reddit",
        },
      });
      kept++;
    }
    log("      reddit (oauth): " + b.name + " — " + kept + " post(s)");
  }
  return { candidates, gaps };
}

async function redditRss({ brands, sinceMs, state, log }) {
  const candidates = [];
  const gaps = [];

  /* OAUTH FIRST when a credential is stored. It is a supported API with
   * published limits, where the anonymous RSS route is a 403 waiting to
   * happen. */
  const token = await redditOAuthToken(log);
  if (token) return redditViaOAuth({ brands, sinceMs, token, log });

  if (isDisabled(state, "reddit")) {
    gaps.push({ reason: "Reddit disabled until " + state.disabled_until.reddit + " — " + state.disabled_reason.reddit });
    log("      reddit: skipped (disabled until " + String(state.disabled_until.reddit).slice(0, 16) + ")");
    return { candidates, gaps };
  }

  for (const id of brands) {
    const b = brand(id);
    const url = "https://www.reddit.com/search.rss?q=" +
      encodeURIComponent('"' + b.aliases[0] + '"') + "&sort=new&t=week";

    const r = await fetchUrl(url, {
      retries: 0,
      timeout: 25000,
      headers: { "User-Agent": "Document360-CompetitiveIntel/2.0 (internal research tool)" },
    });

    if (r.status === 403 || r.status === 429) {
      disableFor(state, "reddit", 24, "HTTP " + r.status + " on search.rss — anonymous access refused");
      gaps.push({ reason: "Reddit refused anonymous RSS (HTTP " + r.status + "); disabled for 24h rather than retried" });
      log("      reddit: HTTP " + r.status + " — disabled for 24h");
      break;
    }
    if (!r.ok) { gaps.push({ brand_id: id, reason: "Reddit RSS HTTP " + r.status }); continue; }

    const entries = String(r.body).split(/<entry>/i).slice(1);
    let kept = 0;
    for (const e of entries) {
      const href = (/<link[^>]+href="([^"]+)"/i.exec(e) || [])[1];
      const title = tagOf(e, "title");
      const updated = tagOf(e, "updated") || tagOf(e, "published");
      const content = htmlToText(tagOf(e, "content") || "");
      if (!href || !title) continue;

      const text = [title, content].filter(Boolean).join(". ");
      const matched = firstAliasIn(text, id);
      if (!matched) continue;
      if (updated && !withinWindow(toIsoDate(updated), sinceMs)) continue;

      candidates.push({
        brand_id: id,
        channel: "web",
        url: decodeEntities(href),
        title: title,
        published_at: toIsoDate(updated),
        date_method: updated ? "reddit:updated" : null,
        source_text: clip(text, 2000),
        source_verified: true,
        source_adapter: "reddit_rss",
        discovered_via: url,
        author: tagOf(e, "name") || null,
        extra: { matched_alias: matched },
      });
      kept++;
    }
    log("      reddit: " + b.name + " — " + kept + " post(s)");
  }
  return { candidates, gaps };
}

/* ============================================================== L. Bluesky */

/**
 * Bluesky, via the public AT Protocol AppView.
 *
 * The best-shaped source in this whole file, and the reason is structural: the
 * AT Protocol is DESIGNED for public consumption. No key, no account, no
 * session to rot, no fingerprinting, no bot wall, and no terms-of-service
 * exposure. Everything the X channel costs in credits and the LinkedIn channel
 * costs in metered SERP queries, this gives away.
 *
 * It is NOT a replacement for X. It is a different network with a different
 * population, and saying otherwise would overstate the coverage. But with
 * twitterapi.io at -518 credits, it is the only microblog source that works at
 * all right now.
 */
async function bluesky({ brands, sinceMs, sinceDays, log }) {
  const candidates = [];
  const gaps = [];

  for (const id of brands) {
    const b = brand(id);
    const url =
      "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=" +
      encodeURIComponent('"' + b.aliases[0] + '"') +
      "&limit=100&sort=latest&since=" + new Date(sinceMs).toISOString();

    const r = await fetchJson(url, { retries: 1, timeout: 25000 });
    if (r.status === 429) {
      gaps.push({ brand_id: id, reason: "Bluesky rate limited this client (burst limit, not a quota)" });
      continue;
    }
    if (!r.ok || !r.json) {
      /* A 403 carrying an HTML body is a NETWORK interstitial, not Bluesky
       * refusing the query. MEASURED from this host: every variant — quoted,
       * unquoted, with and without `since` — returns the same 2.3KB HTML 403
       * with a fonts.bunny.net stylesheet, which no JSON API serves. The
       * AppView itself is unauthenticated and has no reason to refuse.
       *
       * Worth distinguishing, because the two have opposite fixes: a query
       * problem is fixed here, an egress block is fixed by running the sweep
       * from somewhere else. The scheduled GitHub Actions runner has a
       * different IP and is the obvious place to find out. */
      const htmlBlock = r.status === 403 && /<html/i.test(String(r.body || ""));
      gaps.push({
        brand_id: id,
        reason: htmlBlock
          ? "Bluesky returned an HTML 403 interstitial — this egress is blocked at the network " +
            "level, not by the API. The adapter is fine; run it from a different IP (the " +
            "scheduled runner) to confirm."
          : "Bluesky XRPC HTTP " + r.status,
      });
      continue;
    }

    let kept = 0;
    for (const post of r.json.posts || []) {
      const text = (post.record && post.record.text) || "";
      const matched = firstAliasIn(text, id);
      if (!matched) continue;

      const handle = (post.author && (post.author.handle || post.author.did)) || null;
      const rkey = String(post.uri || "").split("/").pop();
      if (!handle || !rkey) continue;

      // createdAt is self-reported by the posting client; indexedAt is the
      // AppView's own observation. Prefer the claim, fall back to the
      // observation, and never invent one.
      const published = toIsoDate(post.record && post.record.createdAt) ||
        toIsoDate(post.indexedAt);
      if (published && !withinWindow(published, sinceMs)) continue;

      candidates.push({
        brand_id: id,
        channel: "x",   // microblog; grouped with the other short-form social
        url: "https://bsky.app/profile/" + handle + "/post/" + rkey,
        title: null,
        published_at: published,
        date_method: published ? "bluesky:createdAt" : null,
        source_text: clip(text, 2000),
        source_verified: true,
        source_adapter: "bluesky",
        discovered_via: url,
        author: (post.author && post.author.displayName) || handle,
        extra: {
          bluesky_handle: handle,
          bluesky_did: (post.author && post.author.did) || null,
          likes: post.likeCount == null ? null : post.likeCount,
          reposts: post.repostCount == null ? null : post.repostCount,
          replies: post.replyCount == null ? null : post.replyCount,
          matched_alias: matched,
        },
      });
      kept++;
    }
    log("      bluesky: " + b.name + " — " + kept + " post(s)");
  }
  return { candidates, gaps };
}

/* ================================================= M. Reddit archive replicas */

/**
 * Reddit through Pushshift-compatible replicas.
 *
 * WHY THIS EXISTS ALONGSIDE reddit_rss: because reddit_rss does not work.
 * Reddit answers this network's anonymous RSS requests with 429, the source
 * self-disables for 24 hours, and the Reddit channel has been contributing
 * nothing. api.pushshift.io itself is dead to the public — its surviving
 * endpoints sit behind a researcher approval queue.
 *
 * PullPush and Arctic Shift are independent replicas with independent
 * operators, so an outage at one is not an outage at both. They also do the
 * thing Reddit's own search is worst at: full-text search across ALL
 * subreddits' COMMENTS, which is where people actually discuss tools.
 *
 * Both are best-effort community infrastructure. A replica being down is a
 * gap, not a zero.
 */
const REDDIT_REPLICAS = [
  {
    id: "pullpush",
    build: (alias, sinceSec) =>
      "https://api.pullpush.io/reddit/search/comment/?q=" + encodeURIComponent(alias) +
      "&size=100&sort=desc&after=" + sinceSec,
    rows: j => (j && j.data) || [],
  },
  {
    id: "arctic-shift",
    build: (alias, sinceSec) =>
      "https://arctic-shift.photon-reddit.com/api/comments/search?body=" +
      encodeURIComponent(alias) + "&limit=100&sort=desc&after=" + sinceSec,
    rows: j => (j && j.data) || [],
  },
];

async function redditReplicas({ brands, sinceMs, log }) {
  const candidates = [];
  const gaps = [];
  const sinceSec = Math.floor(sinceMs / 1000);
  const seen = new Set();

  for (const id of brands) {
    const b = brand(id);
    const alias = b.aliases[0];
    let kept = 0;
    let served = false;

    for (const replica of REDDIT_REPLICAS) {
      const url = replica.build(alias, sinceSec);
      const r = await fetchJson(url, {
        retries: 1,
        timeout: 30000,
        headers: { "User-Agent": "node:d360-competitive-intel:v2.0 (internal research tool)" },
      });
      if (!r.ok || !r.json) {
        gaps.push({ brand_id: id, reason: replica.id + ": HTTP " + r.status });
        continue;
      }
      served = true;

      for (const c of replica.rows(r.json)) {
        if (!c || !c.id || !c.body) continue;
        const matched = firstAliasIn(c.body, id);
        if (!matched) continue;

        const permalink = c.permalink ||
          ("/comments/" + String(c.link_id || "").replace(/^t3_/, "") + "/_/" + c.id);
        const full = "https://www.reddit.com" + permalink;
        // The two replicas index the same comments, so the second pass would
        // duplicate the first without this.
        if (seen.has(full)) continue;
        seen.add(full);

        // toIsoDate, like every other adapter — one date shape across the
        // codebase is what stops the next helper from having to guess.
        const published = c.created_utc
          ? toIsoDate(new Date(c.created_utc * 1000).toISOString())
          : null;
        if (published && !withinWindow(published, sinceMs)) continue;

        candidates.push({
          brand_id: id,
          channel: "web",
          url: full,
          title: null,
          published_at: published,
          date_method: published ? "reddit:created_utc" : null,
          source_text: clip(c.body, 2000),
          source_verified: true,
          source_adapter: "reddit_replica",
          discovered_via: url,
          author: c.author && c.author !== "[deleted]" ? c.author : null,
          extra: {
            subreddit: c.subreddit || null,
            score: c.score == null ? null : c.score,
            replica: replica.id,
            matched_alias: matched,
          },
        });
        kept++;
      }

      // One replica answering is enough; the second is for when it does not.
      if (kept) break;
    }

    if (!served) {
      gaps.push({ brand_id: id, reason: "no Reddit replica answered (both PullPush and Arctic Shift failed)" });
    }
    log("      reddit replicas: " + b.name + " — " + kept + " comment(s)");
  }
  return { candidates, gaps };
}

/* ========================================================= J. Status pages */

const STATUS_FEEDS = {
  mintlify: "https://status.mintlify.com/history.rss",
  gitbook: "https://status.gitbook.com/history.rss",
  confluence: "https://status.atlassian.com/history.rss",
  document360: "https://status.document360.com/history.rss",
  guru: "https://status.getguru.com/history.rss",
};

/**
 * A vendor incident inside the window is a real competitive signal — and one no
 * social source carries, because customers feel an outage before they post
 * about it.
 */
async function statusPages({ brands, sinceMs, log }) {
  const candidates = [];
  const gaps = [];

  for (const id of brands) {
    const feed = STATUS_FEEDS[id];
    if (!feed) continue;
    const r = await fetchUrl(feed, { retries: 0, timeout: 20000 });
    if (!r.ok) { gaps.push({ brand_id: id, reason: "status feed HTTP " + r.status + " (" + domainOf(feed) + ")" }); continue; }

    const items = String(r.body).split(/<item>/i).slice(1);
    let kept = 0;
    for (const raw of items) {
      const title = tagOf(raw, "title");
      const link = tagOf(raw, "link");
      const pub = toIsoDate(tagOf(raw, "pubDate"));
      const desc = htmlToText(tagOf(raw, "description") || "");
      if (!title || !link || !pub) continue;
      if (!withinWindow(pub, sinceMs)) continue;

      candidates.push({
        brand_id: id,
        channel: "web",
        url: link,
        title: title,
        published_at: pub,
        date_method: "statuspage:pubDate",
        source_text: clip([title, desc].filter(Boolean).join(". "), 1500),
        source_verified: true,
        source_adapter: "status_page",
        discovered_via: feed,
        author: "status page",
        extra: { signal_type: "reliability_incident", matched_alias: brand(id).aliases[0] },
      });
      kept++;
    }
    if (kept) log("      status page: " + brand(id).name + " — " + kept + " incident(s) this window");
  }
  return { candidates, gaps };
}

/* ========================================================== K. Alternatives */

const ALT_SLUGS = {
  mintlify: "mintlify", gitbook: "gitbook", document360: "document360",
  confluence: "confluence", guru: "guru", bloomfire: "bloomfire", knowledgeowl: "knowledgeowl",
};

/**
 * An alternatives page refreshed inside the window means buyers are actively
 * comparing that product right now. Recorded as buying intent rather than as a
 * generic web mention, because that is what it is.
 */
async function alternativesPages({ brands, sinceMs, log }) {
  const candidates = [];
  const gaps = [];
  const scrape = require("./scrape");

  for (const id of brands) {
    const slug = ALT_SLUGS[id];
    if (!slug) continue;
    const url = "https://openalternative.co/alternatives/" + slug;

    const r = await scrape.fetchPage(url, { log });
    if (!r.ok) {
      gaps.push({ brand_id: id, reason: "openalternative " + slug + ": " + String(r.error || "unreachable").slice(0, 90) });
      continue;
    }

    const text = htmlToText(r.body);
    const matched = firstAliasIn(text, id);
    if (!matched) continue;

    // The page's own "last updated" is what decides whether this is current.
    const um = /(?:last\s+updated|updated)\s*(?:on)?\s*:?\s*([A-Z][a-z]{2,9}\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/i.exec(text);
    const updated = um ? toIsoDate(um[1]) : null;
    if (!updated || !withinWindow(updated, sinceMs)) continue;

    const esc = matched.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sentence = new RegExp("[^.]*" + esc + "[^.]*\\.", "i").exec(text);
    candidates.push({
      brand_id: id,
      channel: "web",
      url: url,
      title: "Alternatives to " + brand(id).name,
      published_at: updated,
      date_method: "openalternative:last-updated on page",
      source_text: clip(sentence ? sentence[0] : text, 1200),
      source_verified: true,
      source_adapter: "alternatives_page",
      discovered_via: url,
      author: "openalternative.co",
      extra: { signal_type: "asking_for_alternative", page_updated: updated, matched_alias: matched },
    });
    log("      alternatives: " + brand(id).name + " — page refreshed " + updated.slice(0, 10));
  }
  return { candidates, gaps };
}

/* ================================================================ registry */

const SOURCES = [
  { id: "googlenews_rss", label: "Google News RSS", run: googleNewsRss, tier: "primary" },
  { id: "hn_recent", label: "Hacker News (Algolia, by date)", run: hnAlgolia, tier: "primary" },
  { id: "duckduckgo_week", label: "Web search (SearXNG, else DuckDuckGo)", run: duckduckgo, tier: "primary" },
  { id: "youtube_week", label: "YouTube (uploaded this week)", run: youtubeWeek, tier: "primary" },
  { id: "github_recent", label: "GitHub issues & PRs", run: githubSearch, tier: "secondary" },
  { id: "stackexchange", label: "Stack Overflow / Software Engineering", run: stackExchange, tier: "secondary" },
  { id: "status_page", label: "Vendor status pages", run: statusPages, tier: "secondary" },
  { id: "alternatives_page", label: "Alternatives aggregators", run: alternativesPages, tier: "secondary" },
  { id: "bluesky", label: "Bluesky (AT Protocol)", run: bluesky, tier: "primary" },
  { id: "reddit_replica", label: "Reddit (PullPush / Arctic Shift replicas)", run: redditReplicas, tier: "secondary" },
  { id: "mastodon", label: "Mastodon hashtag timelines", run: mastodon, tier: "bonus" },
  { id: "gdelt_recent", label: "GDELT news index", run: gdeltRecent, tier: "bonus" },
  { id: "reddit_rss", label: "Reddit (OAuth if configured, else RSS)", run: redditRss, tier: "bonus" },
];

/**
 * Run the sweep.
 *
 * Returns candidates for the shared verification pipeline. Nothing is stored
 * here: a source saying "found it" is not evidence, and only the pipeline
 * decides what counts as one.
 */
async function sweep({
  brands = null,
  sinceDays = 7,
  sources = null,
  tiers = null,
  /* Per-source deadline. Sized by the caller, because the right answer depends
   * on where this runs: a serverless function has a hard ceiling, a scheduled
   * runner has all day. */
  sourceTimeoutMs = 45000,
  log = () => {},
} = {}) {
  const state = loadState();
  const order = brandOrder();
  const ids = brands && brands.length ? brands.filter(b => order.includes(b)) : order;
  const sinceMs = Date.now() - sinceDays * 864e5;

  let list = SOURCES;
  if (sources && sources.length) list = list.filter(s => sources.includes(s.id));
  if (tiers && tiers.length) list = list.filter(s => tiers.includes(s.tier));

  const candidates = [];
  const gaps = [];
  const perSource = [];

  /* SOURCES RUN CONCURRENTLY, AND THIS IS SAFE FOR A SPECIFIC REASON.
   *
   * This loop used to be sequential, which made the sweep's wall-clock the SUM
   * of every source: DuckDuckGo's 11s throttle, GDELT's 8s, plus seven brands
   * of GitHub at 7s each. On a serverless function with a hard ceiling that is
   * the difference between finishing and being killed mid-run.
   *
   * Concurrency is safe here because RATE LIMITING LIVES IN lib/fetch.js AND IS
   * PER HOST. Two sources running at once hit different hosts and do not
   * contend; two requests to the SAME host still serialise behind that host's
   * throttle regardless of how many callers are waiting. So parallelism buys
   * wall-clock without spending politeness — which is the only reason it is
   * acceptable against sources that have blocked us before.
   *
   * Bounded rather than unbounded: a fan-out of every source at once opens
   * dozens of sockets and, on a small Lambda, memory is the next wall after
   * time. Six is comfortably below that and still collapses the critical path.
   *
   * EACH SOURCE GETS ITS OWN DEADLINE. One pathological source must not consume
   * the whole budget — a timeout is reported as a GAP, which is the honest
   * shape: we could not ask, rather than nobody said anything.
   */
  const CONCURRENCY = 6;
  const perSourceBudgetMs = Math.max(15000, Number(sourceTimeoutMs) || 45000);

  async function runOne(src) {
    const t0 = Date.now();
    log("    > " + src.label);
    try {
      const r = await Promise.race([
        src.run({ brands: ids, sinceMs, sinceDays, state, log }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("exceeded its " + Math.round(perSourceBudgetMs / 1000) + "s budget")),
            perSourceBudgetMs
          )
        ),
      ]);
      candidates.push(...(r.candidates || []));
      (r.gaps || []).forEach(g => gaps.push(Object.assign({ source: src.id }, g)));
      perSource.push({
        id: src.id, label: src.label, tier: src.tier,
        candidates: (r.candidates || []).length,
        gaps: (r.gaps || []).length,
        seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
        ok: true,
      });
    } catch (e) {
      const msg = String((e && e.message) || e);
      log("      ERROR: " + msg);
      perSource.push({
        id: src.id, label: src.label, tier: src.tier, candidates: 0, gaps: 0,
        seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
        ok: false, error: msg,
      });
      // A source that could not be asked is a GAP, never a zero.
      gaps.push({ source: src.id, reason: msg });
    }
  }

  const queue = list.slice();
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const next = queue.shift();
      if (!next) return;
      await runOne(next);
    }
  });
  // allSettled, not all: runOne already catches, but a bug in the worker itself
  // must not lose the sources that did finish.
  await Promise.allSettled(workers);

  // Restore the declared order so the report reads the same way every run.
  const declaredOrder = new Map(list.map((x, i) => [x.id, i]));
  perSource.sort((a, b) => (declaredOrder.get(a.id) ?? 99) - (declaredOrder.get(b.id) ?? 99));

  // Belt and braces: the results are already collected at this point, and
  // nothing about persisting a counter is worth losing them for.
  let statePersisted = true;
  try {
    const receipt = saveState(state);
    statePersisted = !!(receipt && receipt.ok);
  } catch (e) {
    statePersisted = false;
  }

  return {
    state_persisted: statePersisted,
    candidates,
    gaps,
    per_source: perSource,
    swept_at: new Date().toISOString(),
    window_days: sinceDays,
    window_start: new Date(sinceMs).toISOString(),
    brands: ids,
    sources_run: list.map(s => s.id),
  };
}

module.exports = { sweep, SOURCES, literalAlias, firstAliasIn, loadState, saveState };
