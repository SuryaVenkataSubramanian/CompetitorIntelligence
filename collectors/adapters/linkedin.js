/**
 * Adapter: LinkedIn  →  channel "linkedin"
 * Repos wired: https://github.com/joeyism/linkedin_scraper          (Python, Playwright)
 *              https://github.com/josephlimtech/linkedin-profile-scraper-api (Node, Puppeteer)
 *
 * CREDENTIAL-GATED AND CURRENTLY DORMANT.
 *
 * This adapter needs a LinkedIn session cookie (LINKEDIN_LI_AT). Without it, it
 * returns zero candidates and a machine-readable "not connected" status that the
 * dashboard renders as an explicit unconnected state. It never estimates, and it
 * never lets another source silently stand in for LinkedIn data.
 *
 * Division of labour between the two repos:
 *   joeyism/linkedin_scraper  — CompanyPostsScraper is the useful one for mention
 *                               tracking: company posts + engagement counts.
 *                               v3+ is Playwright-based and async.
 *   josephlimtech/...-api     — profile-only (Node/Puppeteer). Useful for
 *                               enriching a named author, NOT for finding
 *                               mentions. Wired for that narrow role only.
 *
 * Note on risk, stated once as fact: automating LinkedIn is contrary to its User
 * Agreement and can get the account restricted. Use a burner account, keep the
 * request rate low (this adapter caps at 1 profile / 6s), and prefer the
 * SearXNG `site:linkedin.com` path — which needs no credential and no automation
 * against LinkedIn itself — where it is sufficient.
 */
const path = require("path");
const { runPython, pythonAvailable } = require("../lib/python");
const { allBrands } = require("../lib/brands");
const { toIsoDate } = require("../lib/verify");

const SCRIPT = path.join(__dirname, "..", "python", "linkedin_collect.py");

function credentialStatus() {
  const cookie = process.env.LINKEDIN_LI_AT || "";
  if (!cookie) {
    return {
      ok: false,
      reason: "LINKEDIN_LI_AT not set — LinkedIn channel is not connected.",
      how_to_enable:
        "Log in to LinkedIn, copy the `li_at` cookie value from DevTools → Application → Cookies, " +
        "put it in .env as LINKEDIN_LI_AT, then run: npm run collect:linkedin",
    };
  }
  return { ok: true, reason: null };
}

module.exports = {
  id: "linkedin",
  label: "LinkedIn company posts",
  channel: "linkedin",
  requires: ["LINKEDIN_LI_AT", "python3 + linkedin-scraper + playwright chromium"],
  credentialStatus,
  available() {
    return credentialStatus();
  },

  /** Reported to the dashboard so the UI can show a precise unconnected state. */
  connectionStatus() {
    const cred = credentialStatus();
    const py = pythonAvailable();
    return {
      id: "linkedin",
      label: "LinkedIn",
      connected: cred.ok && py.ok,
      blockers: [
        !cred.ok ? cred.reason : null,
        !py.ok ? py.reason : null,
      ].filter(Boolean),
      how_to_enable: cred.how_to_enable || null,
      fallback_in_use:
        "SearXNG `site:linkedin.com` discovery supplies partial LinkedIn coverage without credentials. " +
        "It finds publicly indexed posts only, so counts are a floor, not a total.",
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

    const targets = allBrands()
      .filter(b => b.linkedin_slug)
      .map(b => ({ brand_id: b.id, slug: b.linkedin_slug, name: b.name }));

    const out = await runPython(SCRIPT, {
      mode: "company_posts",
      targets,
      since_days: sinceDays,
      li_at: process.env.LINKEDIN_LI_AT,
      max_posts_per_company: 40,
    });

    if (!out.ok) {
      log(`    python collector failed: ${out.error}`);
      return { candidates: [], gaps: [{ brand_id: null, reason: `LinkedIn collector failed: ${out.error}` }], unavailable: true };
    }

    const candidates = [];
    for (const p of out.json.posts || []) {
      if (!p.url || !p.brand_id) continue;
      candidates.push({
        brand_id: p.brand_id,
        channel: "linkedin",
        url: p.url,
        title: p.title || (p.text ? String(p.text).slice(0, 120) : null),
        published_at: toIsoDate(p.posted_at) || null,
        date_method: p.posted_at ? "linkedin:posted_at" : null,
        source_text: p.text || null,
        source_verified: true, // came from an authenticated LinkedIn session
        source_adapter: "linkedin",
        discovered_via: `https://www.linkedin.com/company/${p.company_slug}/posts/`,
        author: p.author || null,
        extra: {
          platform: "linkedin",
          reactions: p.reactions ?? null,
          comments: p.comments ?? null,
          reposts: p.reposts ?? null,
          company_slug: p.company_slug || null,
        },
      });
    }
    log(`    ${candidates.length} LinkedIn posts collected`);
    return { candidates, gaps: out.json.gaps || [] };
  },
};
