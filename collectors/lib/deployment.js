/**
 * What this deployment can and cannot do.
 *
 * The project was built to run as a long-lived local process: collectors spawn
 * child processes, write JSON to disk, and query a SearXNG instance on
 * localhost. A serverless host provides none of that. Rather than let those
 * endpoints fail in ways that look like missing data, each capability is
 * declared here and the API refuses the impossible ones with the reason.
 *
 * WHAT BREAKS ON A SERVERLESS HOST, AND WHY
 * -----------------------------------------
 *   writable filesystem  Only /tmp, per-instance and ephemeral. So the AI
 *                        probe still runs (DataForSEO is plain HTTP) but its
 *                        history cannot accumulate — worth saying, because a
 *                        history that silently resets is worse than none.
 *   child processes      The collectors take minutes; a function is capped at
 *                        60s (Hobby) / 300s (Pro). Discovery, the directory
 *                        audit and the digest cannot run there.
 *   localhost SearXNG    Not reachable. That removes web discovery, the
 *                        directory audit and the free SERP fallback.
 *   shared memory        Each cold start is a new process, which is why
 *                        sessions must be stateless (see lib/session.js).
 *
 * The hosted app is therefore a READER of data collected elsewhere, plus the
 * live AI-visibility probe. Collection belongs on a machine or a scheduled
 * runner that has a filesystem and SearXNG — see .github/workflows/collect.yml.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

function isServerless() {
  return !!(
    process.env.VERCEL ||
    process.env.NETLIFY ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.DEPLOY_MODE === "readonly"
  );
}

/** Where a best-effort write can go. Ephemeral on a serverless host. */
function scratchDir() {
  return isServerless() ? path.join(os.tmpdir(), "d360ci") : null;
}

function capabilities() {
  const serverless = isServerless();
  return {
    mode: serverless ? "hosted (serverless, read-only)" : "local (full)",
    serverless,
    platform: process.env.VERCEL ? "vercel"
      : process.env.NETLIFY ? "netlify"
        : process.env.AWS_LAMBDA_FUNCTION_NAME ? "aws-lambda"
          : "self-hosted",

    // Reading committed data always works.
    read_data: true,

    persistent_writes: !serverless,
    persistent_writes_note: serverless
      ? "The filesystem is read-only apart from /tmp, which is per-instance and discarded. AI-probe results are returned but not added to the stored history."
      : null,

    spawn_collectors: !serverless,
    spawn_collectors_note: serverless
      ? "Collectors are child processes that run for minutes and need SearXNG on localhost; a serverless function has neither. Run them locally (npm run collect, npm run discover, npm run directories) or on a schedule — see .github/workflows/collect.yml — and commit the refreshed data/."
      : null,

    searxng: !serverless,
    searxng_note: serverless
      ? "SearXNG is a local service and is not reachable from a serverless host, so the free SERP fallback is unavailable. AI Visibility still works: DataForSEO covers all six surfaces over plain HTTP."
      : null,

    // These are pure HTTP APIs and work anywhere the keys are set.
    ai_probe: true,
    first_party_referrals: true,
    webhooks_send: true,
    webhooks_persist: !serverless,
  };
}

/**
 * Guard for an endpoint that needs something this deployment lacks.
 * Returns null when allowed, or { status, body } to return verbatim.
 */
function refuseIfUnavailable(capability) {
  const caps = capabilities();
  if (caps[capability]) return null;
  return {
    status: 501,
    body: {
      ok: false,
      error: "not_available_in_this_deployment",
      capability,
      mode: caps.mode,
      reason: caps[`${capability}_note`] ||
        `This deployment cannot provide "${capability}".`,
      // So the reader knows where it CAN be done, rather than just that it failed.
      where_to_run: "Run this locally with `npm start`, or on a scheduled runner with a filesystem.",
    },
  };
}

/** A write that is allowed to fail on a read-only filesystem. */
function bestEffortWrite(absPath, contents) {
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, contents);
    return { ok: true, persisted: !isServerless() };
  } catch (e) {
    return { ok: false, persisted: false, error: String(e.message || e) };
  }
}

module.exports = { isServerless, capabilities, refuseIfUnavailable, scratchDir, bestEffortWrite };
