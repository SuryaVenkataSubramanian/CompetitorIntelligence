/**
 * Engine health probe.  `npm run searxng:engines`
 *
 * The rate-limit problem has one root cause: only ONE engine (`google cse`) was
 * actually serving, and it suspends after ~40 queries. Every blocked query in the
 * coverage report traces back to that.
 *
 * This SearXNG build exposes 61 general-category engines. Most were never enabled.
 * Rather than guess which work from this host, this probes each one individually
 * with a real brand query and reports:
 *
 *   results  - how many it returned
 *   relevant - how many actually mention the brand (an engine returning 20
 *              unrelated results is worse than one returning none, because its
 *              output looks like data)
 *
 * Output is a ready-to-paste engine list for settings-local.yml, ordered by
 * usefulness. Spreading load across many engines is what makes deeper collection
 * possible without tripping any single provider's limit.
 */
const { fetchJson } = require("../lib/fetch");

const BASE = (process.env.SEARXNG_URL || "http://127.0.0.1:8888").replace(/\/$/, "");
const TERM = process.argv[2] || "Document360";
const CONCURRENCY = 3;

async function listEngines() {
  const r = await fetchJson(`${BASE}/config`, { timeout: 20000 });
  if (!r.ok || !r.json) throw new Error("cannot read /config from " + BASE);
  return (r.json.engines || [])
    .filter(e => (e.categories || []).includes("general"))
    .map(e => e.name);
}

async function probe(engine) {
  const q = encodeURIComponent(`"${TERM}"`);
  const url = `${BASE}/search?q=${q}&format=json&engines=${encodeURIComponent(engine)}&language=en&safesearch=0`;
  const r = await fetchJson(url, { timeout: 40000, retries: 0 });
  if (!r.ok || !r.json) {
    return { engine, ok: false, results: 0, relevant: 0, note: `HTTP ${r.status}` };
  }
  const res = r.json.results || [];
  const unresponsive = (r.json.unresponsive_engines || [])
    .map(x => (Array.isArray(x) ? x.join(": ") : String(x)))
    .join("; ");
  const rx = new RegExp(TERM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const relevant = res.filter(x => rx.test(`${x.url} ${x.title || ""} ${x.content || ""}`)).length;
  return {
    engine,
    ok: res.length > 0,
    results: res.length,
    relevant,
    note: unresponsive || (res.length === 0 ? "no results" : ""),
  };
}

(async () => {
  const engines = await listEngines();
  console.log(`\nProbing ${engines.length} general engines at ${BASE} with "${TERM}"\n`);

  const out = [];
  let i = 0;
  async function worker() {
    while (i < engines.length) {
      const e = engines[i++];
      const r = await probe(e);
      out.push(r);
      const verdict = r.relevant > 0 ? "USE " : r.results > 0 ? "junk" : "dead";
      console.log(
        `  ${verdict}  ${r.engine.padEnd(22)} results=${String(r.results).padStart(3)}  relevant=${String(r.relevant).padStart(3)}  ${String(r.note).slice(0, 60)}`
      );
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Useful = returned results AND at least some of them are on-brand.
  const useful = out.filter(r => r.relevant > 0).sort((a, b) => b.relevant - a.relevant);
  const junk = out.filter(r => r.results > 0 && r.relevant === 0);
  const dead = out.filter(r => r.results === 0);

  console.log(`\n── ${useful.length} usable · ${junk.length} returning off-brand results · ${dead.length} dead ──\n`);
  console.log("Paste into collectors/searxng/settings-local.yml under `engines:`\n");
  for (const r of useful) {
    console.log(`  - name: ${r.engine}`);
    console.log(`    disabled: false          # ${r.relevant}/${r.results} on-brand`);
  }
  if (junk.length) {
    console.log(`\n  # DISABLED — returned results but none mentioning the brand. An engine that`);
    console.log(`  # answers confidently with unrelated content is worse than one that fails,`);
    console.log(`  # because its output looks like data.`);
    for (const r of junk) {
      console.log(`  - name: ${r.engine}`);
      console.log(`    disabled: true           # 0/${r.results} on-brand`);
    }
  }
  console.log(`\n  # ${dead.length} engine(s) returned nothing and are left disabled: ${dead.map(d => d.engine).join(", ")}\n`);
})();
