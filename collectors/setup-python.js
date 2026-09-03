/**
 * Installs the Python sidecar for the credential-gated collectors.
 *
 *   npm run setup:python
 *
 * Creates collectors/python/.venv, installs twikit + linkedin-scraper, and
 * installs the Playwright Chromium build that linkedin_scraper v3+ requires.
 * Reports exactly what failed rather than leaving a half-built venv.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PY_DIR = path.join(__dirname, "python");
const VENV = path.join(PY_DIR, ".venv");
const isWin = process.platform === "win32";
const venvPy = path.join(VENV, isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");

function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  return r.status === 0;
}

function findSystemPython() {
  // Explicit install locations first. On Windows, `python` on PATH is often the
  // Microsoft Store App Execution Alias stub (a 0-byte reparse point to
  // AppInstallerPythonRedirector.exe) which is NOT an interpreter — it just opens
  // the Store. A winget/python.org per-user install lands under LOCALAPPDATA and
  // must be preferred over that stub.
  const explicit = [];
  if (isWin) {
    const la = process.env.LOCALAPPDATA || "";
    const pf = process.env.ProgramFiles || "";
    for (const v of ["314", "313", "312", "311", "310", "39"]) {
      explicit.push(path.join(la, "Programs", "Python", `Python${v}`, "python.exe"));
      explicit.push(path.join(pf, `Python${v}`, "python.exe"));
    }
  }

  const candidates = [
    ...explicit,
    ...(isWin ? ["python", "py", "python3"] : ["python3", "python"]),
  ];

  for (const c of candidates) {
    // Skip the Store alias stub outright.
    if (typeof c === "string" && /WindowsApps/i.test(c)) continue;
    if (c.includes(path.sep) && !fs.existsSync(c)) continue;
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status !== 0) continue;
    const v = (r.stdout || r.stderr || "").trim();
    if (/Microsoft Store|was not found/i.test(v)) continue; // alias stub speaking
    const m = v.match(/(\d+)\.(\d+)/);
    if (m && (+m[1] > 3 || (+m[1] === 3 && +m[2] >= 8))) return { cmd: c, version: v };
    console.log(`  ! ${c} is ${v} — linkedin_scraper needs Python 3.8+`);
  }
  return null;
}

console.log("\nSetting up the Python sidecar (twikit + linkedin_scraper)\n");

const sys = findSystemPython();
if (!sys) {
  console.error("  ! No suitable Python found. Install Python 3.8+ and re-run: npm run setup:python\n");
  process.exit(1);
}
console.log(`  using ${sys.cmd} (${sys.version})\n`);

if (!fs.existsSync(venvPy)) {
  if (!run(sys.cmd, ["-m", "venv", VENV])) {
    console.error("\n  ! Could not create the virtualenv.\n");
    process.exit(1);
  }
} else {
  console.log("  venv already exists — reusing\n");
}

if (!run(venvPy, ["-m", "pip", "install", "--upgrade", "pip", "--quiet"])) {
  console.error("\n  ! pip upgrade failed\n");
}

if (!run(venvPy, ["-m", "pip", "install", "-r", path.join(PY_DIR, "requirements.txt")])) {
  console.error("\n  ! Dependency install failed. The LinkedIn and X collectors will stay dormant.\n");
  process.exit(1);
}

// linkedin_scraper v3+ drives Playwright, which needs its own browser download.
if (!run(venvPy, ["-m", "playwright", "install", "chromium"])) {
  console.error("\n  ! `playwright install chromium` failed — the LinkedIn collector needs it.\n");
}

console.log(`
Python sidecar installed.

These collectors are still DORMANT until credentials are set in .env:

  LinkedIn   LINKEDIN_LI_AT=<li_at cookie from your browser>
             then: npm run collect:linkedin

  X          X_USERNAME=, X_EMAIL=, X_PASSWORD=
             then: npm run collect:x

Both automate platforms whose terms prohibit it and can get an account
restricted — use a burner account. Where SearXNG's site: search is sufficient,
prefer it: it needs no credential and no automation against those platforms.
`);
