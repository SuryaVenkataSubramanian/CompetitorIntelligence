/**
 * Minimal .env loader — this project has no npm dependencies, so no dotenv.
 *
 * SECURITY BOUNDARY: this is required only by server-side code (server.js and
 * collectors/*). Nothing under public/ imports it, and no API route echoes a key.
 * The browser only ever receives /api/* payloads built from the normalized store,
 * so credentials never cross into frontend code.
 *
 * Existing process env always wins, so a real environment variable or CI secret
 * overrides the file rather than the other way round.
 */
const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, "..", "..", ".env");

let loaded = false;

function load() {
  if (loaded) return process.env;
  loaded = true;
  if (!fs.existsSync(ENV_PATH)) return process.env;

  const text = fs.readFileSync(ENV_PATH, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip matching surrounding quotes if present.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
  return process.env;
}

/** Redacted form for logs and the Data Quality panel — never the raw key. */
function keyStatus(name) {
  load();
  const v = process.env[name];
  if (!v) return { name, present: false, hint: null };
  return {
    name,
    present: true,
    // Enough to confirm which key is loaded, not enough to use it.
    hint: v.length > 10 ? `${v.slice(0, 5)}…${v.slice(-3)} (${v.length} chars)` : `(${v.length} chars)`,
  };
}

module.exports = { load, keyStatus, ENV_PATH };
