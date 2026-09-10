/**
 * Document360 — Competitive Intelligence
 * Zero-dependency static + API server. Run: `npm start`
 *
 * AUTHENTICATED. Four allow-listed accounts (see collectors/lib/auth.js);
 * provision with `npm run auth:init`.
 *
 * Public:      /login, /css/*, /js/login.js, /assets/*, POST /api/login
 * Gated:       everything else, including all data endpoints
 *
 * The gate is DENY-BY-DEFAULT: any path not explicitly public requires a valid
 * session. Adding a new endpoint therefore inherits protection rather than
 * needing to remember to add it.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { load } = require("./collectors/lib/env");
const auth = require("./collectors/lib/auth");
const webhook = require("./collectors/lib/webhook");
const aiProbe = require("./collectors/lib/ai-probe");
const aiHistory = require("./collectors/lib/ai-history");
const aiCitations = require("./collectors/lib/ai-citations");
const mailer = require("./collectors/lib/mailer");
const brightdata = require("./collectors/lib/brightdata");
const deployment = require("./collectors/lib/deployment");

load();

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const DATA = path.join(__dirname, "data");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const COOKIE = "d360_session";

// Serialises prompt probes. SearXNG's upstream engines rate-limit per client, so
// two concurrent probes reliably turn both into failed measurements.
let probeInFlight = false;
// Guards the competitor refresh the same way: two discovery sweeps would race on
// the shared keyword cursor file.
let refreshInFlight = false;
// And the directory audit, which shares the seen-products state file.
let dirAuditInFlight = false;

/* ------------------------------------------------------------------ helpers */

function send(res, code, type, body, extraHeaders = {}) {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    // Set here rather than in vercel.json: that file must use the
    // filesystem-overriding "routes" field to keep the auth gate in front of
    // public/, and Vercel rejects "routes" combined with "headers". Setting
    // them in the handler also applies them identically when self-hosted.
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    ...extraHeaders,
  });
  res.end(body);
}

function json(res, code, obj, extraHeaders = {}) {
  send(res, code, MIME[".json"], JSON.stringify(obj), extraHeaders);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  // Behind no proxy here, so socket address is authoritative. X-Forwarded-For is
  // deliberately NOT trusted: it is attacker-controlled and would let someone
  // sidestep the per-IP login lockout by rotating the header.
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      data += c;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function readData(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, file), "utf8"));
  } catch (e) {
    return fallback;
  }
}

/** Collector-side store files (health, capabilities) rather than built data. */
function readStore(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "collectors", "store", file), "utf8"));
  } catch (e) {
    return fallback;
  }
}

/* --------------------------------------------------------------- payloads */

function buildData() {
  const meta = readData("meta.json", null);
  if (!meta) {
    return {
      error: "no_data",
      message:
        "data/ has not been built yet. Run: npm run collect, then node collectors/build.js",
    };
  }
  return {
    meta,
    brands: readData("brands.json", {}),
    ai: readData("ai.json", { status: "not_measured" }),
    recommendations: readData("recommendations.json", { recommendations: [] }),
    competitors: readData("competitors.json", { status: "not_scanned", competitors: [] }),
  };
}

/* ------------------------------------------------------------------ routing */

// Paths reachable without a session. Everything else is denied by default.
const PUBLIC_PATHS = new Set(["/login", "/login.html", "/api/login", "/favicon.ico"]);
const PUBLIC_PREFIXES = ["/css/", "/assets/"];
const PUBLIC_FILES = new Set(["/js/login.js"]);

function isPublic(url) {
  if (PUBLIC_PATHS.has(url)) return true;
  if (PUBLIC_FILES.has(url)) return true;
  return PUBLIC_PREFIXES.some(p => url.startsWith(p));
}

/**
 * The whole app as one request handler.
 *
 * Exported so a serverless host can mount it directly (see api/index.js)
 * without a second copy of the routing, the auth gate or the payload builders.
 */
async function handleRequest(req, res) {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  const cookies = parseCookies(req.headers.cookie);
  const session = auth.sessionFor(cookies[COOKIE]);

  /* ---------------------------------------------------------------- auth */

  if (url === "/api/login" && req.method === "POST") {
    let body = {};
    try { body = JSON.parse(await readBody(req) || "{}"); } catch (e) { /* invalid json */ }
    const r = auth.login(body.email, body.password, clientIp(req));
    if (!r.ok) {
      // A deliberate small delay: it blunts rapid online guessing without
      // affecting a legitimate login.
      await new Promise(x => setTimeout(x, 350));
      return json(res, 401, { ok: false, error: r.error });
    }
    return json(res, 200, { ok: true, email: r.email }, {
      // HttpOnly so script cannot read it; SameSite=Strict so it is not sent
      // cross-site; Path=/ so it covers the whole app.
      "Set-Cookie": `${COOKIE}=${r.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(r.expires_in_ms / 1000)}`,
    });
  }

  if (url === "/api/logout" && req.method === "POST") {
    const out = cookies[COOKIE] ? auth.logout(cookies[COOKIE]) : { revoked_server_side: false };
    // Reported so the UI never claims a server-side revocation that a
    // stateless deployment cannot perform.
    return json(res, 200, { ok: true, revoked_server_side: !!out.revoked_server_side }, {
      "Set-Cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    });
  }

  if (url === "/api/me") {
    if (!session) return json(res, 401, { authenticated: false });

    const derivedAuth = require("./collectors/lib/derived-auth");
    /* The caller's OWN password, and only their own.
     *
     * Deliberately not all four. Passwords here are derived from
     * SESSION_SECRET, so an endpoint returning every account would turn one
     * hijacked session into disclosure of every credential on the deployment —
     * a real amplification, even though the four accounts see identical data.
     * Self-service recovery needs only your own; distributing the initial set
     * is `npm run auth:passwords`, run once by whoever owns the deployment.
     */
    let ownPassword = null;
    let mode = "stored";
    if (derivedAuth.available()) {
      mode = "derived";
      try { ownPassword = derivedAuth.derivePassword(session.email); } catch (e) { ownPassword = null; }
    }

    return json(res, 200, {
      authenticated: true,
      email: session.email,
      credential_mode: mode,
      // Shown so a local/host secret mismatch is visible rather than inferred
      // from a login that mysteriously fails.
      secret_fingerprint: derivedAuth.available() ? derivedAuth.secretFingerprint() : null,
      own_password: ownPassword,
      own_password_note: ownPassword
        ? "Derived from SESSION_SECRET. Rotating that secret changes it and signs everyone out."
        : "Passwords on this deployment are stored as scrypt hashes and cannot be displayed — that is by design.",
    });
  }

  /* -------------------------------------------------------------- the gate */

  if (!isPublic(url) && !session) {
    if (url.startsWith("/api/")) {
      return json(res, 401, { error: "unauthenticated", message: "Sign in to access this data." });
    }
    // Browser navigation → the login page.
    return send(res, 302, "text/plain", "Redirecting to sign in", { Location: "/login" });
  }

  // An authenticated user hitting /login goes to the dashboard.
  if ((url === "/login" || url === "/login.html") && session) {
    return send(res, 302, "text/plain", "Already signed in", { Location: "/" });
  }

  /* ------------------------------------------------------------- webhooks */

  if (url === "/api/webhook") {
    if (req.method === "GET") return json(res, 200, webhook.publicConfig());
    if (req.method === "POST") {
      let body = {};
      try { body = JSON.parse(await readBody(req) || "{}"); } catch (e) { /* invalid json */ }
      const r = await webhook.configure(body);
      return json(res, r.ok ? 200 : 400, r);
    }
    return json(res, 405, { error: "method not allowed" });
  }

  if (url === "/api/webhook/test" && req.method === "POST") {
    const r = await webhook.testPing();
    return json(res, r.ok ? 200 : 400, r);
  }

  /* ------------------------------------------------------------------ data */

  if (url === "/api/data") {
    try { return json(res, 200, buildData()); }
    catch (e) { return json(res, 500, { error: String(e) }); }
  }
  if (url === "/api/audit") {
    return json(res, 200, readData("audit.json", { excluded_unverified: [] }));
  }
  if (url === "/api/competitors") {
    return json(res, 200, readData("competitors.json", { status: "not_scanned", competitors: [] }));
  }

  /** Review-directory listings: new products across 7 directories × 6 categories. */
  if (url === "/api/directories") {
    return json(res, 200, readData("directory-listings.json", {
      status: "not_audited",
      reason: "No directory audit has run yet. Run: npm run directories",
      products: [],
    }));
  }

  /**
   * Run a directory audit on demand. Spawned as a child process so a long
   * sweep cannot block the server, and so it shares the exact code path the
   * CLI and the daily job use.
   */
  if (url === "/api/directories/refresh" && req.method === "POST") {
    // A serverless host has no filesystem or child processes; say so rather
    // than failing in a way that reads as missing data.
    {
      const no = deployment.refuseIfUnavailable("spawn_collectors");
      if (no) return json(res, no.status, no.body);
    }
    if (dirAuditInFlight) {
      return json(res, 429, {
        ok: false,
        error: "A directory audit is already running. They are serialised because they share the seen-products state file.",
      });
    }
    let body = {};
    try { body = JSON.parse(await readBody(req) || "{}"); } catch (e) { /* invalid json */ }

    dirAuditInFlight = true;
    const { spawn } = require("child_process");
    const args = [path.join(__dirname, "collectors", "directory-audit.js")];
    if (body.directory) args.push(`--dir=${String(body.directory).replace(/[^a-z]/g, "")}`);
    if (body.category) args.push(`--cat=${String(body.category).replace(/[^a-z_]/g, "")}`);
    if (body.resolve !== false) args.push("--resolve");

    const started = new Date().toISOString();
    const child = spawn(process.execPath, args, { cwd: __dirname });
    let out = "";
    child.stdout.on("data", d => { out += d.toString(); });
    child.stderr.on("data", d => { out += d.toString(); });

    const finished = await new Promise(resolve => {
      // A full 7×6 sweep is ~126 searches; bound the HTTP wait but let the
      // child finish and land its result in the store either way.
      const timer = setTimeout(() => resolve({ timedOut: true, code: null }), 12 * 60 * 1000);
      child.on("close", code => { clearTimeout(timer); resolve({ timedOut: false, code }); });
      child.on("error", e => { clearTimeout(timer); resolve({ timedOut: false, code: -1, error: e.message }); });
    });
    dirAuditInFlight = false;

    const data = readData("directory-listings.json", { products: [] });
    return json(res, finished.timedOut ? 202 : 200, {
      ok: !finished.timedOut && finished.code === 0,
      started_at: started,
      finished_at: new Date().toISOString(),
      timed_out: finished.timedOut,
      exit_code: finished.code,
      totals: data.totals || null,
      per_category: data.per_category || null,
      log: out.split("\n").filter(Boolean).slice(-40),
    });
  }

  /* ------------------------------------------------------------ AI visibility */

  /**
   * Run a custom buyer prompt against every AI surface that can genuinely be
   * measured, and record the result in history.
   *
   * Deliberately slow: it performs a live SERP query rather than returning a
   * cached guess. The requirement is explicit that accuracy outranks speed.
   */
  if (url === "/api/ai/probe" && req.method === "POST") {
    let body = {};
    try { body = JSON.parse(await readBody(req) || "{}"); } catch (e) { /* invalid json */ }
    const prompt = String(body.prompt || "").trim();
    if (!prompt) return json(res, 400, { ok: false, error: "prompt is required" });
    if (prompt.length > 500) return json(res, 400, { ok: false, error: "prompt must be 500 characters or fewer" });

    // One probe at a time. Concurrent SERP queries from the same instance get
    // the upstream engines rate-limited, which would turn real measurements into
    // "measurement_failed" for everyone.
    if (probeInFlight) {
      return json(res, 429, {
        ok: false,
        error: "A prompt probe is already running. Concurrent SERP queries trigger upstream rate limits, so probes are serialised — retry in a moment.",
      });
    }
    probeInFlight = true;
    try {
      // Surfaces are validated against the known set: an unknown id would
      // otherwise be silently dropped and the reader would think it was checked.
      const requested = Array.isArray(body.surfaces) ? body.surfaces : null;
      const surfaces = requested
        ? requested.filter(s => aiProbe.PROVIDERS[s])
        : null;
      if (requested && !surfaces.length) {
        return json(res, 400, {
          ok: false,
          error: `No valid surface requested. Valid: ${aiProbe.PROVIDER_ORDER.join(", ")}`,
        });
      }

      const r = await aiProbe.probe(prompt, {
        brandId: body.brand_id || "document360",
        days: Number(body.days) || 365,
        surfaces,
        cheap: body.cheap === true,
        useCache: body.refresh !== true,
        log: m => console.log("  [ai-probe] " + m),
      });
      if (!r.ok) return json(res, 400, r);
      const entry = aiHistory.record(r);
      return json(res, 200, { ok: true, entry_id: entry.id, ...r });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e.message || e) });
    } finally {
      probeInFlight = false;
    }
  }

  if (url === "/api/ai/history") {
    const h = aiHistory.readHistory();
    return json(res, 200, {
      updated_at: h.updated_at || null,
      count: h.entries.length,
      // Trim the payload: the browser needs the summary rows, and asks for a
      // single entry when the user opens it.
      entries: h.entries.slice(0, 200).map(e => ({
        id: e.id,
        prompt: e.prompt,
        brand_id: e.brand_id,
        probed_at: e.probed_at,
        providers: Object.fromEntries(Object.entries(e.providers).map(([k, v]) => [k, {
          status: v.status,
          reason: v.reason || null,
          label: v.label || null,
          result_count: v.result_count ?? null,
          confidence: v.confidence ?? null,
          brands: v.brands || null,
          citations: v.citations || null,
          open_search: v.open_search || null,
          how_to_enable: v.how_to_enable || null,
          method: v.method || null,
        }])),
      })),
    });
  }

  if (url === "/api/ai/metrics") {
    const q = new URLSearchParams((req.url || "").split("?")[1] || "");
    const since = q.get("since") || null;
    return json(res, 200, {
      computed_at: new Date().toISOString(),
      window_since: since,
      brands: aiHistory.allMetrics({ since }),
      availability: aiProbe.providerAvailability(),
      note:
        "Every rate is computed over MEASURED checks only. Surfaces that could not be queried are " +
        "excluded from the denominator and reported separately as coverage — counting them as " +
        "'not visible' would understate visibility by however many surfaces are unreachable.",
    });
  }

  if (url === "/api/ai/citations") {
    const q = new URLSearchParams((req.url || "").split("?")[1] || "");
    const brandId = q.get("brand") || "document360";
    const since = q.get("since") || null;
    return json(res, 200, {
      brand_id: brandId,
      computed_at: new Date().toISOString(),
      prompts: aiCitations.analyse(brandId, { since }),
      domain_authority: aiCitations.domainAuthority(brandId, { since }).slice(0, 40),
      gaps: aiHistory.gaps(brandId, { since }),
    });
  }

  /**
   * First-party AI referral traffic (Windsor.ai → GA4).
   *
   * Free to query and cached for an hour, so this is also the layer that keeps
   * working when the DataForSEO balance is exhausted.
   */
  if (url === "/api/ai/referrals") {
    try {
      const windsor = require("./collectors/lib/windsor");
      if (!windsor.configured()) {
        return json(res, 200, { ok: false, ...windsor.credentialStatus() });
      }
      const q = new URLSearchParams((req.url || "").split("?")[1] || "");
      const r = await windsor.aiReferrals({
        datePreset: q.get("range") === "30" ? "last_30d" : "last_90d",
        log: m => console.log("  [windsor]" + m),
      });
      return json(res, 200, r);
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  if (url === "/api/ai/assets") {
    return json(res, 200, readData("rank-assets.json", {
      status: "not_generated",
      recommendations: [],
      reason:
        "No ranking assets have been generated yet. Probe some buyer prompts in AI Visibility, then run " +
        "`npm run assets:build` and have Claude Code fill the queue, then `npm run assets:apply`.",
    }));
  }

  /* ------------------------------------------------- competitor live refresh */

  /**
   * Run a live discovery sweep. Spawned as a child process so a long sweep
   * cannot block the HTTP server, and so it shares exactly the code path the
   * CLI and the daily job use — one collector, not three.
   */
  if (url === "/api/competitors/refresh" && req.method === "POST") {
    // A serverless host has no filesystem or child processes; say so rather
    // than failing in a way that reads as missing data.
    {
      const no = deployment.refuseIfUnavailable("spawn_collectors");
      if (no) return json(res, no.status, no.body);
    }
    if (refreshInFlight) {
      return json(res, 429, {
        ok: false,
        error: "A discovery sweep is already running. They are serialised because they share the keyword cursor.",
      });
    }
    let body = {};
    try { body = JSON.parse(await readBody(req) || "{}"); } catch (e) { /* invalid json */ }
    const keywords = Math.min(40, Math.max(4, parseInt(body.keywords, 10) || 16));
    const recent = body.recent !== false; // default to recent-launch bias

    refreshInFlight = true;
    const { spawn } = require("child_process");
    const started = new Date().toISOString();
    const args = [path.join(__dirname, "collectors", "discover-competitors.js"), `--keywords=${keywords}`];
    if (recent) args.push("--recent");

    const child = spawn(process.execPath, args, { cwd: __dirname });
    let out = "";
    child.stdout.on("data", d => { out += d.toString(); });
    child.stderr.on("data", d => { out += d.toString(); });

    const finished = await new Promise(resolve => {
      // Bound the wait so the HTTP request cannot hang indefinitely; the sweep
      // itself keeps running and its result lands in the store either way.
      const timer = setTimeout(() => resolve({ timedOut: true, code: null }), 8 * 60 * 1000);
      child.on("close", code => { clearTimeout(timer); resolve({ timedOut: false, code }); });
      child.on("error", e => { clearTimeout(timer); resolve({ timedOut: false, code: -1, error: e.message }); });
    });
    refreshInFlight = false;

    // Mirror the collector's store output into data/ so /api/competitors serves it.
    let copied = false;
    try {
      const src = path.join(__dirname, "collectors", "store", "competitors.json");
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(DATA, "competitors.json"));
        copied = true;
      }
    } catch (e) { /* reported below */ }

    const data = readData("competitors.json", { competitors: [] });
    return json(res, finished.timedOut ? 202 : 200, {
      ok: !finished.timedOut && finished.code === 0,
      started_at: started,
      finished_at: new Date().toISOString(),
      timed_out: finished.timedOut,
      exit_code: finished.code,
      published: copied,
      keywords_requested: keywords,
      recent_mode: recent,
      new_this_run: data.new_this_run ?? null,
      total: (data.competitors || []).length,
      by_classification: data.by_classification || null,
      rejected: (data.rejected_this_run || []).length,
      // The collector's own log, so a failed sweep is diagnosable from the UI.
      log: out.split("\n").filter(Boolean).slice(-40),
    });
  }

  /* ------------------------------------------------------------------ health */

  /**
   * Live API health. Reads the stored result from `npm run api:health` and
   * refreshes the DataForSEO balance, because the balance is the one field that
   * goes stale in a way that changes what the UI should offer.
   */
  if (url === "/api/health") {
    const stored = readStore("api-health.json", { checked_at: null, sources: [], summary: {} });

    let live = null;
    try {
      const dfsLib = require("./collectors/lib/dataforseo");
      if (dfsLib.configured()) {
        const b = await dfsLib.balance();
        if (b.ok) {
          const perProbe = dfsLib.estimateProbeCost({}).total;
          const minBal = Number(process.env.DATAFORSEO_MIN_BALANCE || 0.05);
          live = {
            balance: b.balance,
            per_probe_cost: perProbe,
            probes_remaining: Math.floor(Math.max(0, b.balance - minBal) / perProbe),
            spend: dfsLib.readSpend(),
            min_balance: minBal,
          };
        }
      }
    } catch (e) { /* stored values stand */ }

    // Merge the live balance into the stored DataForSEO row so the UI reads one
    // shape regardless of when the health check last ran.
    const sources = (stored.sources || []).map(s =>
      s.name === "DataForSEO" && live
        ? {
          ...s, ...live,
          state: live.balance < live.min_balance ? "BROKEN"
            : live.probes_remaining < 5 ? "DEGRADED" : "WORKING",
          detail: `balance $${Number(live.balance).toFixed(4)}; ~${live.probes_remaining} full 6-surface probe(s) left at $${live.per_probe_cost.toFixed(4)} each`,
          balance_checked_at: new Date().toISOString(),
        }
        : s);

    return json(res, 200, { ...stored, sources, live_balance: !!live });
  }

  /* ------------------------------------------------------------------ digest */

  /**
   * Run one digest pass on demand. `discover:false` skips the (slow) sweep and
   * re-diffs the last stored scan, which is what makes the button usable
   * interactively rather than a five-minute wait.
   */
  if (url === "/api/digest/run" && req.method === "POST") {
    // A serverless host has no filesystem or child processes; say so rather
    // than failing in a way that reads as missing data.
    {
      const no = deployment.refuseIfUnavailable("spawn_collectors");
      if (no) return json(res, no.status, no.body);
    }
    let body = {};
    try { body = JSON.parse(await readBody(req) || "{}"); } catch (e) { /* invalid json */ }
    try {
      const digest = require("./collectors/daily-digest");
      const r = await digest.run({
        discover: body.discover === true,
        keywords: Math.min(40, Math.max(4, parseInt(body.keywords, 10) || 16)),
        log: m => console.log("  [digest]" + m),
      });
      return json(res, r.ok ? 200 : 400, r);
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  if (url === "/api/digest") {
    const latest = readData("digest-latest.json", null);
    return json(res, 200, {
      latest,
      email: mailer.status(),
      brightdata: {
        configured: brightdata.configured(),
        request_api: brightdata.requestApi(),
      },
    });
  }
  if (url === "/api/status") {
    const meta = readData("meta.json", null);
    const audit = readData("audit.json", null);
    return json(res, 200, {
      built_at: meta ? meta.built_at : null,
      integrity: meta ? meta.integrity : null,
      caveats: meta ? meta.caveats : null,
      data_quality: meta ? meta.data_quality : null,
      collector_run: audit ? audit.collector_run : null,
      auth: auth.status(),
      webhook: webhook.publicConfig(),
    });
  }

  /* ---------------------------------------------------------------- static */

  let rel = url === "/" ? "/index.html" : url === "/login" ? "/login.html" : url;
  rel = path.normalize(rel).replace(/^(\.\.[\\/])+/, "");
  const filePath = path.join(PUBLIC, rel);
  if (!filePath.startsWith(PUBLIC)) {
    return send(res, 403, "text/plain", "Forbidden");
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) return send(res, 404, "text/plain", "Not found: " + rel);
    send(res, 200, MIME[path.extname(filePath)] || "application/octet-stream", buf);
  });
}

/* --------------------------------------------------------------- bootstrap */

// Exported first, so a serverless host can require this file for the handler
// alone without starting a listener.
module.exports = handleRequest;
module.exports.handleRequest = handleRequest;

/* Only listen when run directly (`npm start`). Under Vercel this file is
 * imported by api/index.js, where binding a port would be wrong. */
if (require.main === module) {
  const server = http.createServer(handleRequest);

  // Drop expired sessions periodically so the map cannot grow without bound.
  setInterval(() => auth.sweep(), 10 * 60 * 1000).unref();

  server.listen(PORT, () => {
    const meta = readData("meta.json", null);
    const a = auth.status();
    const w = webhook.publicConfig();
    const caps = deployment.capabilities();
    console.log("");
    console.log("  Document360 — Competitive Intelligence");
    console.log("  > http://localhost:" + PORT);
    console.log(`  > mode: ${caps.mode}`);
    console.log(`  > sessions: ${a.session_mode}`);
    console.log(`  > auth: ${a.configured}/${a.allowed} accounts provisioned` +
      (a.configured === 0 ? "  — run: npm run auth:init" : ""));
    console.log(`  > webhook: ${w.enabled ? "enabled -> " + w.url : "not configured"}`);
    if (meta && meta.integrity) {
      const i = meta.integrity;
      console.log(
        `  > ${i.verified_records} verified records · ${i.with_exact_date} dated · ` +
          `${i.sentiment_classified} classified · ${i.links_verified_working} live links`
      );
      if (i.sentiment_unclassified) {
        console.log(`  ! ${i.sentiment_unclassified} record(s) unclassified — run /refresh-intel in Claude Code`);
      }
    } else {
      console.log("  ! data/ not built yet — see README");
    }
    console.log("");
  });
}
