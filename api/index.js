/**
 * Vercel serverless entry point.
 *
 * The whole app is one request handler exported by ../server.js, so there is a
 * single implementation of the routing, the deny-by-default auth gate and the
 * payload builders. This file only adapts it to the function signature and
 * fails loudly on the two misconfigurations that would otherwise produce
 * confusing behaviour in production.
 *
 * WHAT THE HOSTED APP DOES
 *   Serves the dashboard, every read endpoint over the committed data/, the
 *   login flow, the live AI-visibility probe (DataForSEO) and first-party
 *   referral traffic (Windsor.ai).
 *
 * WHAT IT DOES NOT
 *   Run collectors. They are child processes that take minutes and need
 *   SearXNG on localhost — a function has neither. Those endpoints return
 *   HTTP 501 with the reason and where to run them instead. Collection happens
 *   locally or on a schedule (.github/workflows/collect.yml) and the refreshed
 *   data/ is committed; the deploy then serves it.
 */
const handler = require("../server");

// Vercel sets VERCEL=1; this makes the read-only posture explicit for any code
// that checks DEPLOY_MODE rather than the platform variable.
process.env.DEPLOY_MODE = process.env.DEPLOY_MODE || "readonly";

/**
 * Configuration that must be right before the first request, checked once per
 * cold start.
 *
 * SESSION_SECRET is fatal rather than defaulted: without it every cold start
 * would invalidate all cookies, and the team would experience that as a login
 * that randomly forgets them. A clear 500 naming the missing variable is far
 * cheaper to diagnose.
 */
function preflight() {
  const problems = [];

  const secret = process.env.SESSION_SECRET || "";
  if (secret.length < 32) {
    problems.push({
      variable: "SESSION_SECRET",
      why:
        "Required on a serverless host. Sessions are HMAC-signed cookies because each cold start is a " +
        "new process; with no key, nobody stays signed in.",
      fix: 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
        "then add it to the Vercel project's Environment Variables.",
    });
  }

  // Accounts are provisioned into a gitignored file, so a fresh deploy has
  // none. Without this check the login page would simply reject every attempt.
  let accounts = 0;
  try {
    accounts = require("../collectors/lib/auth").status().configured;
  } catch (e) { /* reported below as zero */ }
  if (!accounts) {
    problems.push({
      variable: "AUTH_USERS_JSON",
      why:
        "No accounts are provisioned. collectors/store/auth-users.json holds the password hashes and is " +
        "gitignored, so it is absent from a fresh deploy and every login would be rejected.",
      fix:
        "Run `npm run auth:init` locally, then paste the contents of collectors/store/auth-users.json into " +
        "an AUTH_USERS_JSON environment variable in Vercel.",
    });
  }

  return problems;
}

let checked = null;

module.exports = async (req, res) => {
  if (checked === null) checked = preflight();

  if (checked.length) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify({
      error: "deployment_not_configured",
      message: `${checked.length} required setting(s) are missing. The app is deployed but cannot serve requests safely.`,
      problems: checked,
      docs: "See the Deployment section of README.md.",
    }, null, 2));
  }

  return handler(req, res);
};
