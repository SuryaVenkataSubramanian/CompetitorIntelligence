#!/usr/bin/env node
/**
 * Bright Data capability probe.
 *
 * WHY THIS EXISTS: Bright Data is not one API. It is a family of products (SERP
 * API, Web Unlocker, Web Scraper datasets, Browser API) and which of them a
 * token can actually reach depends entirely on what zones and dataset
 * subscriptions the account has. Coding against a guessed zone name produces a
 * 400 that looks like a bug, and coding against a guessed dataset id produces
 * an empty result that looks like "no data found" — which is exactly the kind of
 * false zero this project refuses to render.
 *
 * So we ask the account what it has, write the answer to
 * collectors/store/brightdata-capabilities.json, and every downstream adapter
 * reads that file. A capability that is absent is reported as
 * "not_available" — never as zero.
 *
 * Run: npm run brightdata:probe
 */
const fs = require("fs");
const path = require("path");
const { load } = require("./lib/env");
const { fetchJson, fetchUrl } = require("./lib/fetch");

load();

const TOKEN = process.env.BRIGHTDATA_API_KEY || "";
const OUT = path.join(__dirname, "store", "brightdata-capabilities.json");

const auth = () => ({ Authorization: "Bearer " + TOKEN });

/** Endpoints worth asking about, each with what a success actually proves. */
const PROBES = [
  {
    id: "token",
    label: "API token valid",
    url: "https://api.brightdata.com/status",
    proves: "The token authenticates against the Bright Data control plane.",
  },
  {
    id: "zones",
    label: "Active zones",
    url: "https://api.brightdata.com/zone/get_active_zones",
    proves: "Which proxy/unlocker/SERP zones exist. A zone name is required by the /request API.",
  },
  {
    id: "datasets",
    // NOTE: /datasets/v3/list does not exist; the working path is /datasets/list.
    // Kept as a named probe so a future API change is visible rather than silent.
    label: "Web Scraper dataset catalogue",
    url: "https://api.brightdata.com/datasets/list",
    proves: "Which scraper datasets (LinkedIn posts, Reddit, YouTube, …) this account may trigger.",
  },
];

/**
 * Which discovery collectors a dataset supports. Sending a deliberately invalid
 * `discover_by` makes the API enumerate the valid ones — more trustworthy than
 * documentation, and it costs nothing because the request is rejected.
 */
async function probeDiscovery(datasetId) {
  const r = await fetchUrl(
    `https://api.brightdata.com/datasets/v3/trigger?dataset_id=${datasetId}&type=discover_new&discover_by=__probe__`,
    {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify([{ keyword: "probe" }]),
      retries: 0,
      timeout: 40000,
    }
  );
  const body = (r.body || "").replace(/\s+/g, " ").trim();
  const m = body.match(/Available types:\s*(.*)$/i);
  return {
    dataset_id: datasetId,
    status: r.status,
    // An empty capture is meaningful: the dataset supports no discovery at all.
    discover: m ? m[1].split(",").map(s => s.trim()).filter(Boolean) : null,
    raw: body.slice(0, 200),
  };
}

/** The datasets this project actually intends to use. */
const USED_DATASETS = {
  linkedin_posts: "gd_lyy3tktm25m4avu764",
  reddit_posts: "gd_lvz8ah06191smkebj4",
  youtube_videos: "gd_lk56epmy2i5g7lzu0k",
  x_posts: "gd_lwxkxvnf1cynvib9co",
  instagram_posts: "gd_lk5ns7kz21pck8jpis",
  facebook_posts: "gd_lyclm1571iy3mv57zw",
};

/**
 * Is there any dataset that scrapes an LLM's answers? Requirement 1 wants
 * ChatGPT/Gemini/Perplexity measured, and Bright Data would be the way to do it
 * — but only if the catalogue contains such a dataset. Answering this from the
 * catalogue rather than from hope is what keeps the AI Visibility panel honest.
 */
function findLlmDatasets(catalogue) {
  const re = /chatgpt|openai|perplexity|gemini|bard|claude|copilot|ai overview|ai_overview/i;
  return catalogue.filter(d => re.test(String(d.name || "") + " " + String(d.id || "")))
    .map(d => ({ id: d.id, name: d.name }));
}

async function probe(p) {
  const r = await fetchJson(p.url, { headers: auth(), retries: 1, timeout: 30000 });
  return {
    id: p.id,
    label: p.label,
    proves: p.proves,
    url: p.url,
    status: r.status,
    ok: r.ok,
    // Store the parsed body when it is small enough to be useful evidence.
    body: r.json != null ? r.json : (r.body || "").slice(0, 600),
    error: r.error || r.parse_error || null,
    checked_at: new Date().toISOString(),
  };
}

/**
 * Does the /request endpoint work with a given zone? This is the call the SERP
 * adapter will make, so proving it here is worth more than proving the zone
 * merely exists. We ask for a trivial page to keep the cost near zero.
 */
async function probeRequest(zone) {
  const r = await fetchUrl("https://api.brightdata.com/request", {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({ zone, url: "https://example.com", format: "raw" }),
    retries: 0,
    timeout: 60000,
  });
  return {
    zone,
    status: r.status,
    ok: r.ok,
    bytes: r.bytes,
    // Proof the fetched page is the real one rather than an error page.
    looks_real: /Example Domain/i.test(r.body || ""),
    error: r.error || (r.ok ? null : (r.body || "").slice(0, 300)),
  };
}

(async () => {
  if (!TOKEN) {
    console.error("BRIGHTDATA_API_KEY is not set in .env — nothing to probe.");
    process.exit(1);
  }

  console.log("\n  Bright Data capability probe");
  console.log("  token: " + TOKEN.slice(0, 5) + "…" + TOKEN.slice(-3) + ` (${TOKEN.length} chars)\n`);

  const results = {};
  for (const p of PROBES) {
    const r = await probe(p);
    results[p.id] = r;
    const mark = r.ok ? "OK  " : "FAIL";
    console.log(`  [${mark}] ${p.label}  → HTTP ${r.status}`);
    if (!r.ok) console.log("         " + String(r.error || "").slice(0, 200));
  }

  /* ---------------------------------------------------------------- zones */
  const zoneList = Array.isArray(results.zones && results.zones.body) ? results.zones.body : [];
  if (zoneList.length) {
    console.log("\n  Zones:");
    for (const z of zoneList) {
      console.log(`    ${String(z.name || z.zone || "?").padEnd(28)} type=${z.type || "?"}`);
    }
  }

  /* ------------------------------------------------------------- datasets */
  const dsList = Array.isArray(results.datasets && results.datasets.body) ? results.datasets.body : [];
  if (dsList.length) {
    console.log(`\n  Datasets (${dsList.length}):`);
    for (const d of dsList.slice(0, 60)) {
      console.log(`    ${String(d.id || "?").padEnd(26)} ${String(d.name || "").slice(0, 60)}`);
    }
    if (dsList.length > 60) console.log(`    … ${dsList.length - 60} more`);
  }

  /* ------------------------------------------------- live /request check */
  // Try each candidate zone until one genuinely returns example.com. Testing
  // beats assuming: a zone can exist and still be unusable (suspended, wrong
  // product type, no balance).
  const candidates = zoneList
    .map(z => z.name || z.zone)
    .filter(Boolean);
  const requestChecks = [];
  let workingZone = null;
  for (const z of candidates) {
    const c = await probeRequest(z);
    requestChecks.push(c);
    console.log(`\n  POST /request zone="${z}" → HTTP ${c.status}${c.looks_real ? "  (returned the real page)" : ""}`);
    if (!c.ok) console.log("      " + String(c.error || "").slice(0, 240));
    if (c.ok && c.looks_real) { workingZone = z; break; }
  }

  /* --------------------------------------------- per-dataset discovery modes */
  console.log("\n  Discovery collectors per dataset:");
  const discovery = {};
  for (const [key, id] of Object.entries(USED_DATASETS)) {
    const d = await probeDiscovery(id);
    discovery[key] = d;
    const modes = d.discover == null
      ? "(could not determine)"
      : d.discover.length ? d.discover.join(", ") : "(none — URL input only)";
    console.log(`    ${key.padEnd(18)} ${modes}`);
  }

  /* ------------------------------------------------------- LLM datasets */
  const llm = findLlmDatasets(dsList);
  console.log(`\n  LLM-answer scraper datasets in catalogue: ${llm.length ? llm.map(x => x.name).join(", ") : "NONE"}`);
  if (!llm.length) {
    console.log("    → ChatGPT / Gemini / Perplexity cannot be measured through Bright Data on this account.");
  }

  const caps = {
    probed_at: new Date().toISOString(),
    token_valid: !!(results.token && results.token.ok) || !!(results.zones && results.zones.ok),
    // The dataset catalogue is ~1755 entries; storing it verbatim bloated this
    // file to 187KB for no benefit. Keep the receipt, drop the payload.
    probes: Object.fromEntries(Object.entries(results).map(([k, v]) => [
      k,
      k === "datasets"
        ? { ...v, body: `[${Array.isArray(v.body) ? v.body.length : 0} datasets — see datasets_used / llm_datasets below]` }
        : v,
    ])),
    zones: zoneList.map(z => ({ name: z.name || z.zone, type: z.type || null })),
    dataset_count: dsList.length,
    // The full 1755-entry catalogue is not worth storing; the used ones are.
    datasets_used: USED_DATASETS,
    discovery,
    llm_datasets: llm,
    request_api: {
      // The single most important output: can we fetch an arbitrary URL through
      // Bright Data, and with which zone?
      available: !!workingZone,
      zone: workingZone,
      checks: requestChecks,
      blocker: workingZone ? null :
        "No zone provisioned on the account. /zone/get_active_zones returned an " +
        "empty list. Create a SERP API or Web Unlocker zone in the Bright Data " +
        "control panel, then re-run this probe.",
    },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(caps, null, 2));
  console.log("\n  written: " + path.relative(process.cwd(), OUT));

  if (workingZone) {
    console.log(`\n  → Add to .env:  BRIGHTDATA_SERP_ZONE=${workingZone}\n`);
  } else {
    console.log("\n  → No usable /request zone. Bright Data features will report" +
      " 'not_available' rather than returning empty results.\n");
  }
})();
