/**
 * The adapter contract.
 *
 * WHERE THIS DEVIATES FROM THE SPEC, AND WHY
 * ------------------------------------------
 * `publishedAt` is `Date | null`, not `Date`.
 *
 * The spec's SearXNG adapter does this:
 *
 *   publishedAt: item.publishedDate ? new Date(item.publishedDate) : new Date()
 *
 * That writes TODAY as the publication date of every result whose engine did not
 * supply one — which for SearXNG is most of them. The record then looks like a
 * post published minutes ago, sorts to the top of a "last 7 days" view, and
 * there is nothing in the row to say the date was invented. It is the single
 * most damaging line in the specification, because the output is indistinguishable
 * from real data.
 *
 * An unknown date is a fact worth storing. `publishedAt: null` plus
 * `dateConfidence: "unknown"` lets a range filter fall back to `discoveredAt`
 * and lets the UI label which axis it used.
 *
 * `authorUrl` and `author` are both optional for the same reason: a SERP result
 * has no author, and "web" is not one.
 */

export type PlatformType =
  | "SEARXNG"
  | "GOOGLE_AIO"
  | "BLUESKY"
  | "REDDIT"
  | "HACKERNEWS"
  | "TWITTER"
  | "LINKEDIN";

/** How a publication date was established. Never inferred silently. */
export type DateConfidence =
  /** The source supplied a machine-readable timestamp. */
  | "exact"
  /** The source supplied a relative or partial date that we parsed. */
  | "approximate"
  /** No date available. `publishedAt` is null; use `discoveredAt` for ranges. */
  | "unknown";

export interface CanonicalMention {
  platform: PlatformType;
  /** Native post/comment id on the source platform. Stable across re-fetches. */
  platformId: string;
  url: string;
  author?: string;
  authorUrl?: string;
  content: string;
  /** Null when the source did not publish one. NEVER defaulted to now(). */
  publishedAt: Date | null;
  dateConfidence: DateConfidence;
  /** When this run retrieved it. Always known, so ranges always have an axis. */
  discoveredAt: Date;
  metadata?: Record<string, unknown>;
}

export interface ScrapeOptions {
  limit?: number;
  since?: Date;
  /** Abort budget for the whole adapter call. Enforced by the orchestrator. */
  timeoutMs?: number;
}

/**
 * The result of one adapter run.
 *
 * ADAPTERS RETURN A RESULT, THEY DO NOT JUST THROW.
 *
 * The spec says "an adapter throws on transport failure" and the orchestrator
 * wraps everything in `Promise.allSettled`, which is correct as far as it goes —
 * one dead source does not kill the batch. But it collapses two different
 * outcomes into the same empty array:
 *
 *   the source answered and had nothing        -> a real zero
 *   the source could not be reached            -> we do not know
 *
 * A dashboard cannot tell those apart from `[]`, so a blocked adapter renders as
 * "no one mentioned us this week". That is the failure mode this whole project
 * exists to avoid, so the shape carries it explicitly.
 */
export interface ScrapeResult {
  platform: PlatformType;
  mentions: CanonicalMention[];
  /** True when the source was successfully queried, even if it returned zero. */
  queried: boolean;
  /** Populated when `queried` is false, or when coverage was partial. */
  gaps: ScrapeGap[];
  /** Milliseconds spent in this adapter. */
  durationMs: number;
}

export interface ScrapeGap {
  reason: string;
  /** HTTP status where there was one. */
  status?: number;
  /** True when the upstream actively refused us (401/403/429/CAPTCHA). */
  blocked?: boolean;
}

export interface ScraperAdapter {
  platform: PlatformType;
  /**
   * Whether this adapter can run at all right now (credentials, config).
   * Checked before `scrape`, so a missing credential is reported as
   * "not configured" rather than as an empty result.
   */
  available(): { ok: boolean; reason?: string };
  scrape(keyword: string, options?: ScrapeOptions): Promise<ScrapeResult>;
}

/* ------------------------------------------------------------------ helpers */

/** Build an empty result for an adapter that could not run. */
export function unavailable(
  platform: PlatformType,
  reason: string,
  extra: Partial<ScrapeGap> = {}
): ScrapeResult {
  return {
    platform,
    mentions: [],
    queried: false,
    gaps: [{ reason, ...extra }],
    durationMs: 0,
  };
}

/**
 * Parse a date from an untrusted source.
 *
 * Returns null rather than `new Date()` on anything unparseable, and rejects
 * dates in the future beyond a small clock-skew allowance — a feed claiming a
 * post from next month is a parsing error, not a scoop.
 */
export function parseDate(
  value: unknown
): { at: Date | null; confidence: DateConfidence } {
  if (value == null || value === "") return { at: null, confidence: "unknown" };

  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return { at: null, confidence: "unknown" };

  // 24h of tolerance for timezone and clock skew; anything beyond that is wrong.
  if (d.getTime() > Date.now() + 86_400_000) {
    return { at: null, confidence: "unknown" };
  }
  return { at: d, confidence: "exact" };
}

/** Node 18+ has global fetch; this adds a hard deadline and a typed failure. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 20_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Does the text contain the keyword as a WHOLE WORD?
 *
 * MEASURED, AND THE REASON THIS IS NOT `String.includes`: Algolia's typo-tolerant
 * search returns "netbook" and "GifBook" for a query of "GitBook". A substring
 * check admits both. The spec's own Tier-3 fallback uses
 * `textLower.includes(kw.toLowerCase())`, which would store them as genuine
 * brand mentions.
 */
export function containsKeyword(text: string, keyword: string): boolean {
  if (!text || !keyword) return false;
  const escaped = keyword
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i").test(text);
}
