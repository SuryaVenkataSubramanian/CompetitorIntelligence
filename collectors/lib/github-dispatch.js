/**
 * Trigger the collection workflow from the hosted app.
 *
 * THE PROBLEM THIS SOLVES, AND WHY IT IS NOT A DATABASE
 * ----------------------------------------------------
 * On Vercel the filesystem is read-only, so the Refresh button collects real
 * mentions and then cannot keep them:
 *
 *   "13 candidate(s) found, 13 passed verification, 0 new. This deployment has
 *    no writable filesystem, so these records were returned but not stored."
 *
 * The usual advice is to add Postgres. That is a legitimate fix and it is the
 * wrong one HERE, for reasons specific to this project:
 *
 *   - It is zero-dependency Node by design. A database means Prisma or pg, a
 *     build step, migrations, a connection pool sized for Lambda, and a second
 *     copy of the store logic. That is a large change to persist what is
 *     already a solved problem.
 *   - THE COLLECTION ALREADY HAS A HOME. .github/workflows/refresh.yml runs the
 *     same sweep on a runner that HAS a filesystem, commits data/ back to the
 *     repo, and that commit redeploys Vercel. The pipeline works; the hosted
 *     app simply had no way to start it.
 *   - A database would persist the records but not fix the root shape: the
 *     hosted app is a READER of collected evidence. Making it a writer means it
 *     also needs the scraping chain, the proxies and the rate-limit state that
 *     the runner already owns.
 *
 * So Refresh on a read-only host does not try to save. It asks the runner to do
 * the collection properly, and says so. The user gets durable data a few minutes
 * later, in the same place all the other data lives, with the same provenance.
 *
 * WHEN A DATABASE WOULD BE THE RIGHT ANSWER: if you need sub-minute freshness,
 * or per-user state, or writes that cannot wait for a commit. None of those are
 * true of a competitive-intelligence dashboard that a team opens a few times a
 * day.
 *
 * CREDENTIAL: a fine-grained PAT with `actions: write` on this repository only,
 * set as GITHUB_DISPATCH_TOKEN. It cannot read the code, cannot push, and
 * cannot touch another repo. If it is absent this module reports itself
 * unavailable and the UI explains the fallback rather than failing.
 */
const { fetchJson } = require("./fetch");

const API = "https://api.github.com";

function config() {
  const token = process.env.GITHUB_DISPATCH_TOKEN || "";
  // Vercel exposes the repo it deployed from, so this usually needs no config.
  const repo =
    process.env.GITHUB_REPOSITORY ||
    (process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG
      ? `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`
      : "");
  const workflow = process.env.GITHUB_DISPATCH_WORKFLOW || "refresh.yml";
  const ref = process.env.GITHUB_DISPATCH_REF || "main";
  return { token, repo, workflow, ref };
}

function status() {
  const c = config();
  if (!c.token) {
    return {
      available: false,
      reason:
        "GITHUB_DISPATCH_TOKEN is not set, so this deployment cannot ask the collection runner " +
        "to fetch and store new mentions.",
      how_to_enable:
        "Create a fine-grained personal access token scoped to this repository with the " +
        "'Actions: write' permission only, then add it to Vercel as GITHUB_DISPATCH_TOKEN. " +
        "It cannot read source, push commits, or reach any other repository.",
      repo: c.repo || null,
    };
  }
  if (!c.repo) {
    return {
      available: false,
      reason:
        "The repository could not be determined. Vercel normally supplies it via " +
        "VERCEL_GIT_REPO_OWNER/SLUG.",
      how_to_enable: "Set GITHUB_REPOSITORY to owner/repo.",
    };
  }
  return { available: true, repo: c.repo, workflow: c.workflow, ref: c.ref, reason: null };
}

/**
 * Ask the runner to collect.
 *
 * Returns a receipt rather than throwing. A dispatch that fails must degrade to
 * "we could not start a run", never to a 500 that loses the sweep results the
 * caller already has in hand.
 */
async function trigger({ days = 7, log = () => {} } = {}) {
  const st = status();
  if (!st.available) return { ok: false, ...st };

  const c = config();
  const url = `${API}/repos/${c.repo}/actions/workflows/${encodeURIComponent(c.workflow)}/dispatches`;
  const body = JSON.stringify({
    ref: c.ref,
    inputs: { days: String(days) },
  });

  const r = await fetchJson(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
    retries: 0,
    timeout: 20000,
  });

  // GitHub answers 204 No Content on success, which is not a JSON body.
  if (r.status === 204) {
    log("      dispatched " + c.workflow + " on " + c.repo);
    return {
      ok: true,
      repo: c.repo,
      workflow: c.workflow,
      runs_url: `https://github.com/${c.repo}/actions/workflows/${c.workflow}`,
      note:
        "A collection run was started on the runner, which has a writable filesystem. It " +
        "collects, verifies, commits data/ and that commit redeploys this app — usually a few " +
        "minutes. These results will then be here permanently.",
    };
  }

  if (r.status === 401 || r.status === 403) {
    return {
      ok: false,
      status: r.status,
      reason:
        `GitHub refused the dispatch (HTTP ${r.status}). The token is missing the ` +
        `'Actions: write' permission on ${c.repo}, or has expired.`,
    };
  }
  if (r.status === 404) {
    return {
      ok: false,
      status: 404,
      reason:
        `No workflow named ${c.workflow} on ${c.repo}@${c.ref}, or the token cannot see the ` +
        `repository. Note that a workflow must already exist on the DEFAULT branch before it ` +
        `can be dispatched.`,
    };
  }
  return {
    ok: false,
    status: r.status,
    reason: `GitHub dispatch failed: HTTP ${r.status} ${String(r.body || "").slice(0, 120)}`,
  };
}

module.exports = { status, trigger };
