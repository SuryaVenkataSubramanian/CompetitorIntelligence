/**
 * HTTP fetch with provenance recording and per-host throttling.
 *
 * Every fetch returns a receipt: what URL was requested, what status came back,
 * when, how many bytes, and the SHA-256 of the body. Nothing downstream is
 * allowed to assert a fact about a page that was not actually fetched here.
 *
 * No LLM is involved at this layer. This layer only reports what the wire said.
 */
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36 D360-CompetitiveIntel/2.0 (+internal research tool)";

// Per-host minimum gap between requests, in ms. GDELT explicitly asks for 1 req / 5s.
const HOST_THROTTLE = {
  "api.gdeltproject.org": 5500,
  /* DataForSEO enforces 6 requests per minute and answers a 7th with
   * "40202 The rates limit per minute has been exceeded: 6 >= 6" — a task-level
   * error inside an HTTP 200, so it does NOT look like a failure to a caller
   * checking status codes. Measured while probing: a burst of ordinary calls
   * tripped it. 10.5s spaces requests just under the limit. */
  "api.dataforseo.com": 10500,
  /* ScrapeBadger free tier is 5 requests/minute and answers a 6th with
   * 429 {"detail":"Rate limit exceeded","limit":5,"tier":"free"}. Tripped it
   * three times while probing, which made real endpoints look like 404s.
   * 13s spaces requests safely under it. */
  "scrapebadger.com": 13000,
  "hn.algolia.com": 300,
  "news.google.com": 1200,
  "www.youtube.com": 800,
  "public.api.bsky.app": 500,
  "api.github.com": 1000,
  "web.archive.org": 1500,
  "archive.org": 1500,
  default: 600,
};

const lastHit = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function throttle(host) {
  const gap = HOST_THROTTLE[host] || HOST_THROTTLE.default;
  const prev = lastHit.get(host) || 0;
  const wait = prev + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Fetch a URL and return a provenance receipt.
 * Never throws on HTTP errors — returns { ok:false, status } so callers must
 * decide explicitly what to do with a failure instead of silently proceeding.
 */
async function fetchUrl(rawUrl, opts = {}) {
  const {
    method = "GET",
    headers = {},
    timeout = 25000,
    maxRedirects = 5,
    retries = 2,
    accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    body = null,
    // Response bodies are capped so a hostile or runaway page cannot exhaust
    // memory. API downloads legitimately exceed the HTML default, so callers
    // can raise it — see collectors/lib/brightdata.js.
    maxBytes = 4 * 1024 * 1024,
  } = opts;

  let attempt = 0;
  let lastErr = null;

  while (attempt <= retries) {
    attempt++;
    try {
      const receipt = await once(rawUrl, {
        method,
        headers,
        timeout,
        maxRedirects,
        accept,
        body,
        maxBytes,
      });
      // 429 / 5xx are worth retrying with backoff; 4xx (other) is a real answer.
      if ((receipt.status === 429 || receipt.status >= 500) && attempt <= retries) {
        const backoff = receipt.status === 429 ? 6000 * attempt : 1500 * attempt;
        await sleep(backoff);
        continue;
      }
      receipt.attempts = attempt;
      return receipt;
    } catch (e) {
      lastErr = e;
      if (attempt <= retries) await sleep(1200 * attempt);
    }
  }

  return {
    ok: false,
    status: 0,
    url: rawUrl,
    final_url: rawUrl,
    fetched_at: nowIso(),
    bytes: 0,
    content_sha256: null,
    body: "",
    error: lastErr ? String(lastErr.message || lastErr) : "unknown fetch error",
    attempts: attempt - 1,
  };
}

function once(rawUrl, opts, redirectsLeft) {
  const depth = redirectsLeft == null ? opts.maxRedirects : redirectsLeft;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(rawUrl);
    } catch (e) {
      return reject(new Error("invalid url: " + rawUrl));
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return reject(new Error("unsupported protocol: " + u.protocol));
    }

    throttle(u.hostname).then(() => {
      const mod = u.protocol === "https:" ? https : http;
      const req = mod.request(
        {
          method: opts.method,
          hostname: u.hostname,
          port: u.port || undefined,
          path: u.pathname + u.search,
          headers: {
            "User-Agent": UA,
            Accept: opts.accept,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "identity", // keep bodies plain so hashing is stable
            ...opts.headers,
          },
          timeout: opts.timeout,
        },
        res => {
          const status = res.statusCode || 0;
          const loc = res.headers.location;

          if (status >= 300 && status < 400 && loc && depth > 0) {
            res.resume();
            let next;
            try {
              next = new URL(loc, u).toString();
            } catch (e) {
              return reject(new Error("bad redirect location: " + loc));
            }
            return once(next, opts, depth - 1).then(resolve, reject);
          }

          const chunks = [];
          let total = 0;
          const CAP = opts.maxBytes || 4 * 1024 * 1024;
          res.on("data", c => {
            total += c.length;
            if (total <= CAP) chunks.push(c);
          });
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            // Truncation must never be silent. A body cut mid-token produces a
            // JSON parse error hundreds of lines deep, which reads like a
            // provider bug; saying so here is what makes it debuggable.
            //
            // It deliberately does NOT clear `ok`: `ok` means the HTTP request
            // succeeded, and a large HTML page whose tail we dropped is still
            // perfectly usable for text extraction. Folding truncation into `ok`
            // made every page over the cap report as unfetchable — buildwithfern.com
            // came back "unreachable (HTTP 200)". Callers that need the whole
            // body (JSON parsers) check `truncated` themselves.
            const truncated = total > CAP;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              url: rawUrl,
              final_url: u.toString(),
              fetched_at: nowIso(),
              bytes: buf.length,
              total_bytes: total,
              truncated,
              content_type: res.headers["content-type"] || null,
              content_sha256: crypto.createHash("sha256").update(buf).digest("hex"),
              body: buf.toString("utf8"),
              error: truncated
                ? `response truncated: ${total} bytes exceeded the ${CAP}-byte cap (pass a larger maxBytes)`
                : null,
            });
          });
          res.on("error", reject);
        }
      );
      req.on("timeout", () => req.destroy(new Error("timeout after " + opts.timeout + "ms")));
      req.on("error", reject);
      if (opts.body) req.write(opts.body);
      req.end();
    }, reject);
  });
}

/** Fetch and parse JSON. Returns { ...receipt, json } with json=null on parse failure. */
async function fetchJson(url, opts = {}) {
  const r = await fetchUrl(url, {
    ...opts,
    accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
  });
  let json = null;
  let parse_error = null;
  if (r.ok && r.body) {
    try {
      json = JSON.parse(r.body);
    } catch (e) {
      // A truncated body is the most likely cause of a parse failure on a large
      // API response, and "Unterminated string at position 4151658" does not say
      // so. Name it, because the fix is a larger maxBytes rather than a retry.
      parse_error = r.truncated
        ? `response truncated at ${r.bytes} of ${r.total_bytes} bytes, so the JSON is incomplete — raise maxBytes`
        : String(e.message || e);
    }
  }
  return { ...r, json, parse_error };
}

/** Run async tasks with bounded concurrency, preserving input order. */
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        out[idx] = await worker(items[idx], idx);
      } catch (e) {
        out[idx] = { __error: String(e.message || e) };
      }
    }
  });
  await Promise.all(runners);
  return out;
}

module.exports = { fetchUrl, fetchJson, pool, sleep, nowIso, UA };
