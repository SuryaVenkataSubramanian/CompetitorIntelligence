/**
 * Adapter: X / Twitter via Bright Data Web Scraper API
 *
 * REPLACES THE CREDENTIAL-BASED ADAPTER, AND WHY THAT MATTERS
 * ----------------------------------------------------------
 * The previous X adapter (x_twikit.js) drove twikit with a real account:
 * X_USERNAME, X_EMAIL, X_PASSWORD. That approach has been dormant since it was
 * written, for reasons no amount of code fixes:
 *
 *   · It needs a burner account, which X suspends for automation.
 *   · A password in .env cannot go to a hosted deployment safely.
 *   · Any login flow breaks on a challenge, a CAPTCHA or a 2FA prompt, at
 *     which point the channel silently stops collecting.
 *
 * Bright Data's X dataset (gd_lwxkxvnf1cynvib9co) needs NO account. Verified
 * live: profile discovery for @document360 returned 5 posts, newest 2 days old,
 * with exact timestamps and engagement — against a store whose newest X record
 * was 10 days stale.
 *
 * So there is no login cadence to build here. That is the better outcome: a
 * scheduled re-login is a thing that fails at 3am, and not having one is
 * strictly more reliable than having one that works most of the time.
 *
 * WHAT IT CAN AND CANNOT DO
 * -------------------------
 * Asked which discovery collectors it supports, the dataset answers:
 *
 *     profile_url, profiles_array        ← no keyword search
 *
 * So this collects the OWNED timeline of each tracked product: what each
 * company posts, and the engagement it earns. It cannot find a stranger
 * tweeting about Document360 — that needs keyword search, which Octolens
 * already provides for the products it watches. The gap is reported rather
 * than papered over.
 */
const { load } = require("../lib/env");
const bd = require("../lib/brightdata");
const { allBrands, brandOrder, matchBrand, brand } = require("../lib/brands");
const {
  classifyType, detectBuyingIntent, detectComparisons, detectEvent,
} = require("../lib/classify");
const { toIsoDate } = require("../lib/verify");

load();

/** One Bright Data collection per this many profiles. */
const BATCH = 7;

function credentialStatus() {
  if (!bd.configured()) {
    return {
      ok: false,
      reason: "BRIGHTDATA_API_KEY not set — X collection is not connected.",
      how_to_enable: "Add BRIGHTDATA_API_KEY to .env, then run: npm run collect:x",
    };
  }
  return { ok: true, reason: null };
}

/**
 * Which tracked products does this post mention?
 *
 * The posting account is a strong signal but not the whole answer: a
 * Document360 post may name a competitor, and that comparison is exactly what
 * this dashboard is for. So the author's brand is recorded, and the text is
 * additionally matched against all seven.
 */
function resolveProducts(row, ownerBrandId) {
  const text = [row.description, row.text, row.quoted_post && row.quoted_post.description]
    .filter(Boolean).join("\n");

  const out = [];
  // The owning account always counts: it is that brand's own channel activity.
  if (ownerBrandId) {
    out.push({ id: ownerBrandId, confidence: 0.99, via: "posted by the brand's own account" });
  }
  // Anyone else named in the text, confirmed by the disambiguating matcher.
  for (const id of brandOrder()) {
    if (id === ownerBrandId) continue;
    const m = matchBrand(text, id);
    if (m.present) {
      out.push({ id, confidence: 0.9, via: "named in the post text", matched: m.matched });
    }
  }
  return out;
}

function toCandidates(row, { ownerBrandId, brands, stage }) {
  const text = [row.description, row.text].filter(Boolean).join("\n");
  if (!text.trim() && !row.url) return [];

  const published = toIsoDate(row.date_posted || row.timestamp);
  const products = resolveProducts(row, ownerBrandId);
  const out = [];

  for (const p of products) {
    if (brands && !brands.includes(p.id)) continue;

    const tags = row.hashtags || [];
    const type = classifyType(text, tags);
    const intent = detectBuyingIntent(text, tags);
    const ev = detectEvent(text, tags);
    const cmp = detectComparisons(text, p.id);

    out.push({
      brand_id: p.id,
      channel: ev.is_sponsorship || ev.is_event ? "event" : "x",
      url: row.url,
      title: null,
      published_at: published,
      date_method: published ? "brightdata:date_posted" : null,

      // Bright Data fetched and returned the post text; it is the post itself.
      source_text: text || null,
      source_verified: true,
      source_adapter: "x_brightdata",
      discovered_via: `brightdata ${bd.DATASETS.x_posts.id} (${stage})`,
      author: row.name || row.user_posted || null,

      api_source: "brightdata",
      // Bright Data supplies no sentiment and this adapter will not invent one.
      sentiment: null,
      sentiment_method: null,
      confidence_score: p.confidence,
      mention_type: type.type,
      mention_type_basis: `${type.by}: ${type.matched || type.type}`,
      buying_intent: intent.intent,
      buying_intent_basis: intent.matched,
      comparison_products: cmp,
      is_event: ev.is_event,
      is_sponsorship: ev.is_sponsorship,
      event_basis: ev.matched,
      provider_tags: tags,

      engagement: {
        likes: row.likes ?? null,
        reposts: row.reposts ?? null,
        replies: row.replies ?? null,
        views: row.views ?? null,
        author_followers: row.followers ?? null,
      },

      extra: {
        x_post_id: row.id || null,
        author_handle: row.user_posted || null,
        posted_by_brand: ownerBrandId || null,
        product_resolution: p.via,
        brand_match_basis: p.matched || null,
        quoted: !!row.quoted_post,
        tagged_users: row.tagged_users || null,
        external_url: row.external_url || null,
        discovery_stage: stage,
      },
    });
  }
  return out;
}

module.exports = {
  id: "x_brightdata",
  label: "X / Twitter (Bright Data Web Scraper)",
  channel: "x",
  requires: ["BRIGHTDATA_API_KEY"],
  credentialStatus,
  available() { return credentialStatus(); },

  coverageLimit: {
    note:
      "The Bright Data X dataset supports discovery by profile_url only — there is no keyword " +
      "search. So this collects each tracked product's OWN timeline and the engagement it earns. " +
      "A third party tweeting about a product without being on one of these timelines is NOT " +
      "found here; Octolens covers keyword mentions for the products it watches. Counts are " +
      "therefore owned-channel activity plus any cross-mentions, not total X volume.",
    discovery_modes: bd.DATASETS.x_posts.discover,
    replaces: "x_twikit (account-credential adapter) — no login is required by this route",
  },

  connectionStatus() {
    const c = credentialStatus();
    return {
      id: "x_brightdata",
      label: "X / Twitter (Bright Data Web Scraper)",
      connected: c.ok,
      blockers: c.ok ? [] : [c.reason],
      how_to_enable: c.how_to_enable || null,
      fallback_in_use: null,
    };
  },

  async collect({ sinceDays = 90, brands = null, log = () => {} } = {}) {
    const cred = credentialStatus();
    if (!cred.ok) {
      log(`    dormant: ${cred.reason}`);
      return { candidates: [], gaps: [{ brand_id: null, reason: cred.reason }], unavailable: true };
    }

    // Map each handle back to its brand, so a post's owner is known rather than
    // guessed from the text.
    const targets = [];
    const gaps = [];
    for (const b of allBrands()) {
      if (brands && !brands.includes(b.id)) continue;
      if (!b.x_handle) {
        gaps.push({ brand_id: b.id, reason: "No x_handle in config/brands.json — X collection skipped." });
        continue;
      }
      targets.push({ brandId: b.id, handle: b.x_handle, url: `https://x.com/${b.x_handle}` });
    }
    if (!targets.length) {
      return { candidates: [], gaps, providerStats: { profiles: 0 } };
    }

    const handleToBrand = new Map(targets.map(t => [String(t.handle).toLowerCase(), t.brandId]));
    const candidates = [];
    const stats = { profiles: targets.length, rows: 0, snapshots: [], batches: 0, errors: [] };

    log(`    ${targets.length} profile(s): ${targets.map(t => "@" + t.handle).join(", ")}`);

    for (let i = 0; i < targets.length; i += BATCH) {
      const chunk = targets.slice(i, i + BATCH);
      stats.batches++;
      const res = await bd.collect(
        bd.DATASETS.x_posts.id,
        chunk.map(t => ({ url: t.url })),
        { discoverBy: "profile_url", maxMs: 12 * 60 * 1000 }
      );

      if (!res.ok) {
        log(`      batch ${stats.batches}: FAILED (${res.status}) ${String(res.error || "").slice(0, 120)}`);
        stats.errors.push(`batch ${stats.batches}: ${res.status} ${res.error}`);
        continue;
      }
      stats.snapshots.push(res.snapshot_id);

      const rows = (res.rows || []).filter(r => r && (r.url || r.description || r.text));
      stats.rows += rows.length;

      for (const row of rows) {
        // Attribute the post to whichever tracked account posted it.
        const posted = String(row.user_posted || "").toLowerCase().replace(/^@/, "");
        const ownerBrandId = handleToBrand.get(posted) || null;
        candidates.push(...toCandidates(row, { ownerBrandId, brands, stage: "profile" }));
      }
      log(`      batch ${stats.batches}: ${rows.length} post(s) → ${candidates.length} mention(s) so far`);
    }

    /* ---------------------------------------------------------- date window */
    // Applied last, so the log can tell "nothing found" apart from "found but
    // older than the window".
    const cutoff = new Date(Date.now() - sinceDays * 864e5);
    const inWindow = candidates.filter(c => {
      if (!c.published_at) return true;   // undated is handled downstream
      return new Date(c.published_at) >= cutoff;
    });
    stats.out_of_window = candidates.length - inWindow.length;

    /* ------------------------------------------------------- coverage gaps */
    const covered = new Set(inWindow.map(c => c.brand_id));
    for (const b of allBrands()) {
      if (covered.has(b.id) || !b.x_handle) continue;
      gaps.push({
        brand_id: b.id,
        reason:
          `No X post from @${b.x_handle} within ${sinceDays} days, and no other tracked account ` +
          `named ${b.name}. Because this dataset has no keyword search, that means "nothing on the ` +
          `owned timeline", not "nobody mentioned it on X".`,
      });
    }
    gaps.push({
      brand_id: null,
      reason:
        "X coverage here is owned-timeline only: the Bright Data dataset supports profile discovery " +
        "but not keyword search, so third-party posts are counted only when they appear on a tracked " +
        "account's timeline.",
    });

    log(`    ${inWindow.length} candidate(s) from ${stats.rows} post(s)` +
      `${stats.out_of_window ? `, ${stats.out_of_window} outside the ${sinceDays}d window` : ""}`);

    return { candidates: inWindow, gaps, providerStats: stats };
  },
};
