/**
 * Python sidecar bridge.
 *
 * twikit and linkedin_scraper are Python; the rest of this project is Node. The
 * bridge keeps that split clean: Node sends a JSON job on stdin, the Python
 * script prints one JSON object on stdout, Node parses it. Anything the Python
 * side writes to stderr is surfaced as a diagnostic instead of being swallowed.
 *
 * If the venv or a library is missing, this reports exactly what to install. It
 * never falls back to producing data by another means.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PY_DIR = path.join(__dirname, "..", "python");
const VENV = path.join(PY_DIR, ".venv");

/** Prefer the project venv; fall back to a system interpreter. */
function pythonBin() {
  const winVenv = path.join(VENV, "Scripts", "python.exe");
  const nixVenv = path.join(VENV, "bin", "python");
  if (fs.existsSync(winVenv)) return winVenv;
  if (fs.existsSync(nixVenv)) return nixVenv;
  return process.platform === "win32" ? "python" : "python3";
}

function pythonAvailable() {
  const bin = pythonBin();
  const isVenv = bin.includes(".venv");
  if (!isVenv && !fs.existsSync(VENV)) {
    return {
      ok: false,
      reason:
        "Python sidecar not installed (collectors/python/.venv missing). Run: npm run setup:python",
      bin,
    };
  }
  return { ok: true, reason: null, bin };
}

/**
 * Run a python script with a JSON job on stdin.
 * Returns { ok, json, error, stderr }.
 */
function runPython(script, job, { timeout = 300000 } = {}) {
  return new Promise(resolve => {
    if (!fs.existsSync(script)) {
      return resolve({ ok: false, json: null, error: "script not found: " + script, stderr: "" });
    }
    const bin = pythonBin();
    let child;
    try {
      child = spawn(bin, [script], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, json: null, error: "could not spawn " + bin + ": " + e.message, stderr: "" });
    }

    let out = "";
    let err = "";
    const killer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, json: null, error: `python script timed out after ${timeout}ms`, stderr: err });
    }, timeout);

    child.stdout.on("data", d => (out += d.toString()));
    child.stderr.on("data", d => (err += d.toString()));
    child.on("error", e => {
      clearTimeout(killer);
      resolve({ ok: false, json: null, error: String(e.message || e), stderr: err });
    });
    child.on("close", code => {
      clearTimeout(killer);
      if (code !== 0) {
        return resolve({
          ok: false,
          json: null,
          error: `python exited ${code}: ${err.trim().split("\n").slice(-3).join(" | ") || "no stderr"}`,
          stderr: err,
        });
      }
      // The contract is exactly one JSON object on stdout.
      const start = out.indexOf("{");
      if (start === -1) {
        return resolve({ ok: false, json: null, error: "python produced no JSON on stdout", stderr: err });
      }
      try {
        resolve({ ok: true, json: JSON.parse(out.slice(start)), error: null, stderr: err });
      } catch (e) {
        resolve({ ok: false, json: null, error: "could not parse python JSON: " + e.message, stderr: err });
      }
    });

    child.stdin.write(JSON.stringify(job));
    child.stdin.end();
  });
}

module.exports = { runPython, pythonAvailable, pythonBin, PY_DIR, VENV };
