/**
 * Adapter: X (Twitter) via twikit  →  channel "x"
 * Repo: https://github.com/d60/twikit  (Python, scraping-based, no API key)
 *
 * CREDENTIAL-GATED AND CURRENTLY DORMANT.
 *
 * twikit authenticates with a real X account (username + email + password) and
 * persists cookies. Without X_USERNAME / X_EMAIL / X_PASSWORD this adapter
 * returns nothing and reports "not connected". The dashboard shows that state
 * explicitly rather than filling the X column with anything inferred.
 *
 * Note on risk, stated once as fact: twikit drives the private web API, which is
 * contrary to X's terms and can get the account suspended. Use a burner account.
 * The SearXNG `site:x.com` path needs no credential and covers publicly indexed
 * posts, so prefer it where sufficient.
 */
const path = require("path");
const { runPython, pythonAvailable } = require("../lib/python");
const { allBrands, searchTerms } = require("../lib/brands");
const { toIsoDate } = require("../lib/verify");

const SCRIPT = path.join(__dirname, "..", "python", "x_collect.py");

function credentialStatus() {
  const missing = ["X_USERNAME", "X_EMAIL", "X_PASSWORD"].filter(k => !process.env[k]);
  if (missing.length) {
    return {
      ok: false,
      reason: `X channel not connected — missing ${missing.join(", ")}.`,
      how_to_enable:
        "Add X_USERNAME, X_EMAIL and X_PASSWORD to .env (a burner account is strongly advised), " +
        "install the Python sidecar (npm run setup:python), then run: npm run collect:x",
    };
  }
  return { ok: true, reason: null };
}

module.exports = {
  id: "x_twikit",
  label: "X / Twitter (twikit)",
  channel: "x",
  requires: ["X_USERNAME", "X_EMAIL", "X_PASSWORD", "python3 + twikit"],
  credentialStatus,
  available() {
    return credentialStatus();
  },

  connectionStatus() {
    const cred = credentialStatus();
    const py = pythonAvailable();
    return {
      id: "x",
      label: "X",
      connected: cred.ok && py.ok,
      blockers: [!cred.ok ? cred.reason : null, !py.ok ? py.reason : null].filter(Boolean),
      how_to_enable: cred.how_to_enable || null,
      fallback_in_use:
        "SearXNG `site:x.com OR site:twitter.com` discovery supplies partial X coverage without credentials. " +
        "Search engines index only a fraction of posts, so counts are a floor, not a total.",
    };
  },

  async collect({ sinceDays = 90, log = () => {} } = {}) {
    const cred = credentialStatus();
    const py = pythonAvailable();
    if (!cred.ok || !py.ok) {
      const reason = !cred.ok ? cred.reason : py.reason;
      log(`    dormant: ${reason}`);
      return { candidates: [], gaps: [{ brand_id: null, reason }], unavailable: true };
    }

    const targets = allBrands().map(b => ({
      brand_id: b.id,
      name: b.name,
      handle: b.x_handle || null,
      // Exact-phrase search plus the brand's own timeline.
      query: searchTerms(b.id)[0],
    }));

    const out = await runPython(SCRIPT, {
      targets,
      since_days: sinceDays,
      username: process.env.X_USERNAME,
      email: process.env.X_EMAIL,
      password: process.env.X_PASSWORD,
      cookies_path: path.join(__dirname, "..", "store", ".x_cookies.json"),
      max_per_target: 40,
    });

    if (!out.ok) {
      log(`    python collector failed: ${out.error}`);
      return { candidates: [], gaps: [{ brand_id: null, reason: `X collector failed: ${out.error}` }], unavailable: true };
    }

    const candidates = [];
    for (const t of out.json.tweets || []) {
      if (!t.url || !t.brand_id) continue;
      candidates.push({
        brand_id: t.brand_id,
        channel: "x",
        url: t.url,
        title: t.text ? String(t.text).slice(0, 140) : null,
        published_at: toIsoDate(t.created_at) || null,
        date_method: t.created_at ? "x:created_at" : null,
        source_text: t.text || null,
        source_verified: true,
        source_adapter: "x_twikit",
        discovered_via: t.discovered_via || "twikit search",
        author: t.author_handle ? "@" + t.author_handle : null,
        extra: {
          platform: "x",
          tweet_id: t.id || null,
          likes: t.favorite_count ?? null,
          reposts: t.retweet_count ?? null,
          replies: t.reply_count ?? null,
          views: t.view_count ?? null,
          author_followers: t.author_followers ?? null,
        },
      });
    }
    log(`    ${candidates.length} X posts collected`);
    return { candidates, gaps: out.json.gaps || [] };
  },
};
