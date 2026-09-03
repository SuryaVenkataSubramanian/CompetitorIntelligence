/**
 * Node-native metasearch — the no-Docker, no-Python replacement for SearXNG.
 *
 * SearXNG is a Python (Flask) application, so it cannot run without Python and
 * it is normally deployed via Docker. On a locked-down machine (no Docker, no
 * real Python interpreter, no local admin) neither path is available. But this
 * project only uses one narrow slice of SearXNG: "give me ranked web results for
 * a query". That slice is just fetch-engine-HTML-and-parse-it, which is exactly
 * what SearXNG does internally, and it is perfectly doable in Node.
 *
 * So this module reimplements that slice against engines verified reachable from
 * this machine, and exposes the SAME interface as adapters/searxng.js
 * (`search(query, opts) -> { ok, results, url }`) so it is a drop-in provider.
 *
 * ENGINES (measured 2026-08-12 from this host):
 *   duckduckgo  html.duckduckgo.com/html  — 200, 10 clean results, no captcha,
 *                                           direct publisher URLs
 *   bing        www.bing.com/search       — 200, 9 results, no captcha; targets
 *                                           wrapped in /ck/a?...&u=a1<base64url>,
 *                                           decoded here
 *   NOT USED — verified blocked from this host:
 *   brave       JS-rendered / bot-protected (1 external URL on the whole page)
 *   mojeek      captcha
 *   startpage   no parseable result markup
 *   google      no parseable result markup (consent/JS wall)
 *
 * THE HONESTY PROBLEM THIS SOLVES EXPLICITLY
 * ------------------------------------------
 * HTML scraping breaks silently when a site changes its markup — and a broken
 * selector looks exactly like "no results found", which would quietly under-report
 * competitor activity. (This is not hypothetical: the first Bing selector written
 * here returned 0 results against a live 127KB page full of results.)
 *
 * So every engine declares a `liveness` marker. If a fetch returns 200 with
 * result markers present but the parser extracts nothing, that is reported as
 * `parser_drift` — an explicit failure demanding a fix — never as an empty result
 * set. Callers surface it as a coverage gap.
 */
const { fetchUrl } = require("./fetch");

const RESULT_CAP = 25;

/* ------------------------------------------------------------ engines */

function decodeBingTarget(href) {
  const m = String(href).replace(/&amp;/g, "&").match(/[?&]u=a1([^&]+)/);
  if (!m) return /^https?:\/\//.test(href) && !/bing\.com/.test(href) ? href : null;
  try {
    let b = m[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    const s = Buffer.from(b, "base64").toString("utf8");
    return /^https?:\/\//.test(s) ? s : null;
  } catch (e) {
    return null;
  }
}

function decodeDdgTarget(href) {
  // DuckDuckGo sometimes wraps in /l/?uddg=<urlencoded>
  const w = String(href).match(/[?&]uddg=([^&]+)/);
  if (w) {
    try {
      const u = decodeURIComponent(w[1]);
      return /^https?:\/\//.test(u) ? u : null;
    } catch (e) {
      return null;
    }
  }
  if (href.startsWith("//")) href = "https:" + href;
  return /^https?:\/\//.test(href) && !/duckduckgo\.com/.test(href) ? href : null;
}

function strip(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function unent(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#(?:0?39|x27);/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch (e) { return " "; } });
}

const ENGINES = [
  {
    id: "duckduckgo",
    // The /html/ endpoint is the no-JS variant; stable and parser-friendly.
    url: q => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    // If these appear, the page really does contain results.
    liveness: /result__a|result__url|results_links/,
    parse(html) {
      const out = [];
      for (const m of html.matchAll(
        /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
      )) {
        const url = decodeDdgTarget(unent(m[1]));
        if (!url) continue;
        out.push({ url, title: unent(strip(m[2])) || null });
      }
      // Snippets live in a sibling anchor/div; attach positionally where present.
      const snips = [...html.matchAll(
        /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g
      )].map(s => unent(strip(s[1])));
      out.forEach((r, i) => { r.content = snips[i] || null; });
      return out;
    },
  },
  {
    id: "bing",
    url: q => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=20&setlang=en`,
    liveness: /class="b_algo"/,
    parse(html) {
      const out = [];
      for (const block of html.split('<li class="b_algo"').slice(1)) {
        const a = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,300}?)<\/a>/);
        if (!a) continue;
        const url = decodeBingTarget(a[1]);
        if (!url) continue;
        const p = block.match(/<p[^>]*>([\s\S]{0,600}?)<\/p>/);
        out.push({
          url,
          title: unent(strip(a[2])) || null,
          content: p ? unent(strip(p[1])) : null,
        });
      }
      return out;
    },
  },
];

/* --------------------------------------------------- one engine query */

/**
 * Bot-challenge detection. The wording matters: DuckDuckGo's challenge says
 * "confirm this search was made by a human" and is served with HTTP **202**, so
 * a naive /verify you are human/ check plus an `ok` test both miss it and the
 * caller sees "0 results" instead of "we are blocked".
 */
const CHALLENGE = /captcha|unusual traffic|are you a robot|verify you are human|made by a human|select all squares|confirm this search|automated queries|our systems have detected/i;

/**
 * Relevance guard. Once an engine flags the caller as a bot it may keep returning
 * HTTP 200 with well-formed markup but results for something else entirely —
 * measured here: Bing returned WhatsApp pages for "GitBook" and i4.cn for a
 * Bloomfire query. That is worse than an error, because it looks like data.
 *
 * So for any query containing a distinctive term, at least one result must
 * mention it somewhere. Otherwise the response is treated as poisoned.
 */
function relevanceCheck(query, results) {
  const terms = (String(query).match(/"([^"]{3,})"/g) || []).map(t => t.replace(/"/g, ""));
  if (!terms.length) {
    // Fall back to the longest bare word, ignoring operators.
    const words = String(query).replace(/site:\S+|OR|AND/gi, " ").match(/[A-Za-z][A-Za-z0-9]{4,}/g) || [];
    if (!words.length) return { ok: true, checked: false };
    terms.push(words.sort((a, b) => b.length - a.length)[0]);
  }
  if (!results.length) return { ok: true, checked: false };

  // A single lucky match is not evidence the response is sound — a poisoned set
  // can contain one coincidental hit. Require a meaningful share of results to
  // mention the term. Measured: a healthy Bing response scored 10/10, a poisoned
  // one scored 0/10, so the boundary is not delicate.
  const lower = terms.map(t => t.toLowerCase());
  const onTerm = results.filter(r => {
    const blob = `${r.url} ${r.title || ""} ${r.content || ""}`.toLowerCase();
    return lower.some(t => blob.includes(t));
  }).length;
  const share = onTerm / results.length;
  return {
    ok: share >= 0.3,
    checked: true,
    term: terms[0],
    on_term: onTerm,
    total: results.length,
    share: Math.round(share * 100),
  };
}

async function queryEngine(engine, q) {
  const url = engine.url(q);
  const r = await fetchUrl(url, {
    retries: 1,
    timeout: 20000,
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  });

  // DuckDuckGo serves its challenge with 202, which is not a 2xx failure, so the
  // challenge check must run before (and independently of) the status check.
  if (r.body && CHALLENGE.test(r.body.slice(0, 30000))) {
    return {
      engine: engine.id,
      ok: false,
      status: r.status,
      reason: `bot challenge served (HTTP ${r.status}) — this engine has rate-limited the host`,
      results: [],
      blocked: true,
    };
  }
  if (!r.ok) {
    return { engine: engine.id, ok: false, status: r.status, reason: `HTTP ${r.status || "no response"}`, results: [] };
  }

  const hasMarkers = engine.liveness.test(r.body);
  let results = [];
  try {
    results = engine.parse(r.body).slice(0, RESULT_CAP);
  } catch (e) {
    return { engine: engine.id, ok: false, status: r.status, reason: `parser threw: ${e.message}`, results: [], parser_drift: true };
  }

  // The critical distinction: a page full of results that we failed to parse is a
  // BUG, not an empty result set. Reporting it as "0 results" would silently
  // under-report every brand.
  if (hasMarkers && results.length === 0) {
    return {
      engine: engine.id,
      ok: false,
      status: r.status,
      reason: `parser drift — page contains result markup but 0 results parsed (${r.bytes} bytes). The selector for ${engine.id} needs updating in collectors/lib/serp.js`,
      results: [],
      parser_drift: true,
    };
  }
  if (!hasMarkers && results.length === 0) {
    return { engine: engine.id, ok: true, status: r.status, reason: "genuinely no results", results: [] };
  }

  // Poisoned-response guard — see relevanceCheck above.
  const rel = relevanceCheck(q, results);
  if (rel.checked && !rel.ok) {
    return {
      engine: engine.id,
      ok: false,
      status: r.status,
      reason:
        `only ${rel.on_term}/${rel.total} results mention "${rel.term}" (${rel.share}%) — engine is ` +
        `returning largely unrelated content (soft bot-throttling). Discarded rather than treated as findings.`,
      results: [],
      poisoned: true,
    };
  }

  return { engine: engine.id, ok: true, status: r.status, results, url };
}

/* ------------------------------------------------------- rank fusion */

function canon(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/i.test(k)) x.searchParams.delete(k);
    return x.toString().replace(/\/$/, "").toLowerCase();
  } catch (e) {
    return String(u).toLowerCase();
  }
}

/**
 * Merge engine result lists. A URL found by both engines ranks above one found by
 * only one, then by best position — the same reciprocal-rank idea SearXNG uses,
 * so downstream ranking semantics stay comparable.
 */
function fuse(perEngine) {
  const byUrl = new Map();
  for (const res of perEngine) {
    if (!res.ok) continue;
    res.results.forEach((r, i) => {
      const key = canon(r.url);
      const score = 1 / (i + 1);
      const prior = byUrl.get(key);
      if (prior) {
        prior.score += score;
        prior.engines.push(res.engine);
        prior.best_position = Math.min(prior.best_position, i + 1);
        if (!prior.content && r.content) prior.content = r.content;
        if (!prior.title && r.title) prior.title = r.title;
      } else {
        byUrl.set(key, {
          url: r.url,
          title: r.title || null,
          content: r.content || null,
          score,
          engines: [res.engine],
          best_position: i + 1,
        });
      }
    });
  }
  return [...byUrl.values()]
    .sort((a, b) => b.engines.length - a.engines.length || b.score - a.score || a.best_position - b.best_position)
    .map((r, i) => ({
      url: r.url,
      title: r.title,
      content: r.content,
      // Shape-compatible with adapters/searxng.js so callers need no changes.
      engine: r.engines.join("+"),
      publishedDate: null, // engines don't reliably expose one; the page proves its date
      position: i + 1,
      found_by: r.engines,
    }));
}

/* ------------------------------------------------------------- public */

/**
 * Same signature as adapters/searxng.js `_search`.
 * `days` is accepted for interface compatibility but not applied: neither engine
 * exposes a reliable date filter here, and the verification pipeline parses each
 * page's real publication date anyway. Pretending to filter would be worse.
 */
async function search(query, opts = {}) {
  const perEngine = [];
  for (const e of ENGINES) {
    perEngine.push(await queryEngine(e, query));
  }
  const results = fuse(perEngine);
  const working = perEngine.filter(r => r.ok);
  const drift = perEngine.filter(r => r.parser_drift);
  const blocked = perEngine.filter(r => r.blocked);
  const poisoned = perEngine.filter(r => r.poisoned);

  if (!working.length) {
    return {
      ok: false,
      results: [],
      url: null,
      error:
        "all built-in engines failed: " +
        perEngine.map(r => `${r.engine}=${r.reason}`).join("; "),
      engines: perEngine.map(r => ({ id: r.engine, ok: r.ok, reason: r.reason })),
      parser_drift: drift.length > 0,
      blocked: blocked.length > 0,
      poisoned: poisoned.length > 0,
    };
  }

  return {
    ok: true,
    results,
    url: `builtin-metasearch(${working.map(r => r.engine).join("+")})`,
    engines: perEngine.map(r => ({ id: r.engine, ok: r.ok, reason: r.reason || null, count: r.results.length })),
    degraded: working.length < ENGINES.length,
    parser_drift: drift.length > 0,
    drift_detail: drift.map(d => d.reason),
    blocked: blocked.length > 0,
    poisoned: poisoned.length > 0,
    // Callers surface this as a coverage gap so a thin result set is never read
    // as "the competitor was quiet".
    health: perEngine
      .filter(r => !r.ok)
      .map(r => `${r.engine}: ${r.reason}`),
  };
}

/** Availability probe, mirroring searxng.probe(). */
async function probe() {
  const r = await search("knowledge base software", {});
  if (!r.ok) return { ok: false, reason: r.error };
  const failed = (r.engines || []).filter(e => !e.ok);
  return {
    ok: true,
    reason: null,
    detail:
      `built-in metasearch: ${(r.engines || []).filter(e => e.ok).map(e => `${e.id}(${e.count})`).join(", ")}` +
      (failed.length ? ` — unavailable: ${failed.map(e => `${e.id} (${e.reason})`).join(", ")}` : ""),
    degraded: !!r.degraded,
  };
}

/**
 * Capabilities. Measured from this host on 2026-08-12, not assumed.
 *
 * The `site_operator: false` finding is the important one: neither scraped
 * endpoint honours `site:`. Bing returns the same generic brand pages whether or
 * not `site:linkedin.com` is present, and DuckDuckGo's /html/ endpoint returns
 * nothing for such queries. Since the LinkedIn, X and Events channels are built
 * entirely on `site:` and qualifier-term queries, this provider CANNOT serve
 * them — and it must say so, rather than letting a brand's own homepage be filed
 * as a "LinkedIn mention" or an "event sponsorship".
 */
const CAPABILITIES = {
  provider: "builtin",
  site_operator: false,
  site_operator_note:
    "Neither scraped engine honours site:. Bing ignores it and returns generic brand pages; " +
    "DuckDuckGo's /html/ endpoint returns 0 results. Measured 2026-08-12.",
  qualifier_terms: false,
  qualifier_terms_note:
    "Bing largely ignores qualifier words: '\"Bloomfire\" sponsor conference' returned 10 Bloomfire " +
    "homepages and no sponsorship page. Event-sponsorship detection is therefore not viable here.",
  date_filter: false,
  // Channels this provider can legitimately contribute to.
  serves_channels: ["web", "blog"],
  cannot_serve_channels: ["linkedin", "x", "event"],
  reliability:
    "Intermittent. DuckDuckGo serves a CAPTCHA after roughly 10-15 queries; Bing degrades to " +
    "unrelated results once it flags the host. Both are detected and discarded rather than stored, " +
    "so counts are a floor and a thin result set may mean throttling rather than competitor silence.",
};

module.exports = {
  search,
  probe,
  ENGINES,
  CAPABILITIES,
  _decodeBingTarget: decodeBingTarget,
  _fuse: fuse,
  _relevanceCheck: relevanceCheck,
};
