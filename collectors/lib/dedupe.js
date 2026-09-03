/**
 * Cross-API deduplication.
 *
 * Canonical-URL matching alone is not enough once several APIs feed the same
 * store: the same article arrives from NewsAPI, SearXNG and a blog feed under
 * three different URLs (http vs https, ?utm_ params, an AMP variant, a syndicated
 * repost on a different domain). Each would be counted as a separate mention and
 * inflate every figure.
 *
 * Three passes, cheapest and most certain first:
 *
 *   1. canonical URL      — exact identity after normalisation
 *   2. normalised title   + same product   — catches syndication across domains
 *   3. content similarity + same product   — catches retitled reposts
 *
 * When duplicates are found, ONE record survives and it is chosen on provenance
 * quality, not arrival order: a page-verified record with a real publication date
 * beats a provider-only one. The survivor absorbs the others' api_source list, so
 * "seen in 3 sources" is preserved as corroboration rather than lost.
 */

const STOP = new Set([
  "the","a","an","and","or","but","of","for","to","in","on","at","by","with",
  "is","are","was","were","be","been","from","that","this","it","as","how","why",
  "what","best","top","vs","versus","review","guide","2024","2025","2026",
]);

/** Title → comparable token signature. */
function titleKey(title) {
  const toks = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP.has(t));
  // Sorted so word-order changes in a repost still match.
  return toks.sort().join(" ");
}

/** Shingle set for Jaccard similarity on body text. */
function shingles(text, k = 5) {
  const toks = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set();
  for (let i = 0; i + k <= toks.length; i++) out.add(toks.slice(i, i + k).join(" "));
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Provenance quality score — decides which record survives a merge.
 * Deliberately ordered so the most independently-verifiable record wins.
 */
function quality(r) {
  let s = 0;
  if (r.url_verified) s += 40;         // we fetched the URL ourselves
  if (r.published_at) s += 20;         // has a real date
  if (r.evidence) s += 15;
  if (r.sentiment) s += 5;
  if (r.source_verified) s += 5;
  if (r.verification_method === "page") s += 10;
  // Prefer the original over an aggregator repost.
  if (r.domain && !/(^|\.)(?:msn|biztoc|newsbreak|finanzen)\b/i.test(r.domain)) s += 5;
  s += Math.min(5, String(r.evidence || "").length / 200);
  return s;
}

/**
 * Deduplicate a record set.
 * Returns { records, removed, groups } — `groups` documents every merge so the
 * Data Quality panel can report what was collapsed and why.
 */
function dedupe(records, { similarityThreshold = 0.55 } = {}) {
  const groups = [];
  const byUrl = new Map();

  // --- Pass 1: canonical URL (within the same product) ---
  for (const r of records) {
    const key = `${r.brand_id}::${r.canonical_url}`;
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(r);
  }
  let survivors = [];
  for (const [key, set] of byUrl) {
    if (set.length === 1) { survivors.push(set[0]); continue; }
    const best = set.slice().sort((a, b) => quality(b) - quality(a))[0];
    groups.push({
      reason: "same canonical URL",
      kept: best.url,
      removed: set.filter(x => x !== best).map(x => x.url),
      sources: [...new Set(set.map(x => x.api_source || x.source_adapter))],
    });
    survivors.push(mergeInto(best, set));
  }

  // --- Pass 2: normalised title, same product, different URL ---
  const byTitle = new Map();
  for (const r of survivors) {
    const tk = titleKey(r.title);
    if (!tk || tk.length < 12) continue;  // too short to be a reliable signature
    const key = `${r.brand_id}::${tk}`;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(r);
  }
  const droppedByTitle = new Set();
  for (const [key, set] of byTitle) {
    if (set.length < 2) continue;
    const best = set.slice().sort((a, b) => quality(b) - quality(a))[0];
    for (const r of set) if (r !== best) droppedByTitle.add(r);
    groups.push({
      reason: "same normalised title (syndicated copy)",
      kept: best.url,
      removed: set.filter(x => x !== best).map(x => x.url),
      sources: [...new Set(set.map(x => x.api_source || x.source_adapter))],
    });
    Object.assign(best, mergeInto(best, set));
  }
  survivors = survivors.filter(r => !droppedByTitle.has(r));

  // --- Pass 3: content similarity, same product ---
  // Bucketed by brand + channel so this stays near-linear rather than O(n²)
  // across the whole store.
  const buckets = new Map();
  for (const r of survivors) {
    const key = `${r.brand_id}::${r.channel}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const droppedBySim = new Set();
  for (const [, set] of buckets) {
    if (set.length < 2) continue;
    const sig = new Map(set.map(r => [r, shingles(r.evidence, 5)]));
    for (let i = 0; i < set.length; i++) {
      const a = set[i];
      if (droppedBySim.has(a)) continue;
      for (let j = i + 1; j < set.length; j++) {
        const b = set[j];
        if (droppedBySim.has(b)) continue;
        const sim = jaccard(sig.get(a), sig.get(b));
        if (sim < similarityThreshold) continue;
        const [keep, drop] = quality(a) >= quality(b) ? [a, b] : [b, a];
        droppedBySim.add(drop);
        groups.push({
          reason: `content similarity ${(sim * 100).toFixed(0)}%`,
          kept: keep.url,
          removed: [drop.url],
          sources: [...new Set([a, b].map(x => x.api_source || x.source_adapter))],
        });
        Object.assign(keep, mergeInto(keep, [a, b]));
      }
    }
  }
  survivors = survivors.filter(r => !droppedBySim.has(r));

  return {
    records: survivors,
    removed: records.length - survivors.length,
    groups,
  };
}

/**
 * Fold a duplicate set into the survivor. Corroboration is additive — knowing an
 * article surfaced in three APIs is a real signal — while factual fields are only
 * filled in where the survivor lacked them.
 */
function mergeInto(best, set) {
  const sources = [...new Set(set.map(x => x.api_source || x.source_adapter).filter(Boolean))];
  const merged = { ...best };
  merged.also_seen_in = sources.filter(s => s !== (best.api_source || best.source_adapter));
  merged.duplicate_count = set.length;

  for (const r of set) {
    if (r === best) continue;
    if (!merged.published_at && r.published_at) {
      merged.published_at = r.published_at;
      merged.date_confidence = "exact";
      merged.date_method = r.date_method;
    }
    if (!merged.sentiment && r.sentiment) {
      merged.sentiment = r.sentiment;
      merged.sentiment_method = r.sentiment_method;
    }
    if (!merged.author && r.author) merged.author = r.author;
    if (merged.relevance_score == null && r.relevance_score != null) merged.relevance_score = r.relevance_score;
    if (!merged.mention_type && r.mention_type) {
      merged.mention_type = r.mention_type;
      merged.mention_type_basis = r.mention_type_basis;
    }
    if (r.buying_intent && !merged.buying_intent) {
      merged.buying_intent = true;
      merged.buying_intent_basis = r.buying_intent_basis;
    }
    if ((r.comparison_products || []).length > (merged.comparison_products || []).length) {
      merged.comparison_products = r.comparison_products;
    }
    if (r.provider_tags && r.provider_tags.length) {
      merged.provider_tags = [...new Set([...(merged.provider_tags || []), ...r.provider_tags])];
    }
  }
  return merged;
}

module.exports = { dedupe, titleKey, shingles, jaccard, quality };
