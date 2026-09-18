import Parser from "rss-parser";
import {
  CanonicalMention,
  ScrapeGap,
  ScrapeOptions,
  ScrapeResult,
  ScraperAdapter,
  containsKeyword,
  fetchWithTimeout,
  parseDate,
} from "../types";

/**
 * Reddit — archive replica primary, search RSS fallback.
 *
 * WHY NOT reddit.com/search.json
 * ------------------------------
 * Reddit's 2023 API monetization ended unmetered commercial use, and anonymous
 * JSON access from cloud IP ranges now answers 429 immediately — or, worse,
 * serves an HTML challenge with a 200 status, which a JSON parser turns into an
 * empty result rather than an error. That is the silent-zero failure this whole
 * design is built to avoid.
 *
 * THE CHAIN
 *   1. PullPush      Pushshift-compatible replica. Searches comments across all
 *                    subreddits at once — the thing Reddit's own search is worst
 *                    at. Primary because it is purpose-built for this.
 *   2. Arctic Shift  Second replica, indexing 2005 onward. Different operator and
 *                    different uptime, so it covers PullPush's outages rather
 *                    than sharing them.
 *   3. search.rss    Live, first-party, and the only one that sees the last few
 *                    minutes. Feature-flagged: a 403/429 disables it for 24h
 *                    rather than retrying into an IP ban.
 *
 * api.pushshift.io itself is NOT in the chain: it is dead to the public and its
 * remaining endpoints sit behind a researcher approval queue.
 */
export class RedditAdapter implements ScraperAdapter {
  public readonly platform = "REDDIT" as const;

  private readonly pullpush = "https://api.pullpush.io/reddit/search/comment/";
  private readonly arcticShift = "https://arctic-shift.photon-reddit.com/api/comments/search";
  private readonly searchRss = "https://www.reddit.com/search.rss";

  /**
   * A descriptive, non-generic User-Agent is mandatory. Reddit rate-limits
   * generic agents from cloud IPs on the first request; the documented format is
   * <platform>:<app id>:<version> (by /u/<account>).
   */
  private readonly userAgent =
    process.env.REDDIT_USER_AGENT ??
    "node:brand-mention-ingestion:v1.0 (by /u/your_account)";

  /** Module-level so the flag survives across calls within a process. */
  private static rssDisabledUntil = 0;

  available(): { ok: boolean; reason?: string } {
    return { ok: true };
  }

  async scrape(keyword: string, options: ScrapeOptions = {}): Promise<ScrapeResult> {
    const started = Date.now();
    const gaps: ScrapeGap[] = [];

    for (const attempt of [
      () => this.viaPullPush(keyword, options),
      () => this.viaArcticShift(keyword, options),
      () => this.viaRss(keyword, options),
    ]) {
      const result = await attempt();
      if (result.queried) {
        return {
          ...result,
          gaps: [...gaps, ...result.gaps],
          durationMs: Date.now() - started,
        };
      }
      gaps.push(...result.gaps);
    }

    return {
      platform: this.platform,
      mentions: [],
      queried: false,
      gaps,
      durationMs: Date.now() - started,
    };
  }

  /* ------------------------------------------------------------- PullPush */

  private async viaPullPush(
    keyword: string,
    options: ScrapeOptions
  ): Promise<ScrapeResult> {
    const url = new URL(this.pullpush);
    url.searchParams.set("q", keyword);
    url.searchParams.set("size", String(Math.min(options.limit ?? 50, 100)));
    url.searchParams.set("sort", "desc");
    if (options.since) {
      url.searchParams.set("after", String(Math.floor(options.since.getTime() / 1000)));
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(url.toString(), {
        headers: { Accept: "application/json", "User-Agent": this.userAgent },
        timeoutMs: options.timeoutMs ?? 30_000,
      });
    } catch (error) {
      return this.failed(`PullPush unreachable: ${errorMessage(error)}`);
    }

    if (!response.ok) {
      return this.failed(`PullPush returned HTTP ${response.status}`, response.status);
    }

    let payload: { data?: PullPushComment[] };
    try {
      payload = (await response.json()) as { data?: PullPushComment[] };
    } catch (error) {
      return this.failed(`PullPush returned unparseable JSON: ${errorMessage(error)}`);
    }

    const mentions: CanonicalMention[] = [];
    for (const c of payload.data ?? []) {
      if (!c.id || !c.body) continue;
      // The replica's full-text search is looser than an exact phrase match.
      if (!containsKeyword(c.body, keyword)) continue;

      const permalink =
        c.permalink ??
        `/comments/${String(c.link_id ?? "").replace(/^t3_/, "")}/_/${c.id}`;
      const { at, confidence } = parseDate(
        c.created_utc ? new Date(c.created_utc * 1000) : null
      );

      mentions.push({
        platform: this.platform,
        platformId: c.id,
        url: `https://www.reddit.com${permalink}`,
        author: c.author && c.author !== "[deleted]" ? c.author : undefined,
        authorUrl:
          c.author && c.author !== "[deleted]"
            ? `https://www.reddit.com/user/${encodeURIComponent(c.author)}`
            : undefined,
        content: c.body,
        publishedAt: at,
        dateConfidence: confidence,
        discoveredAt: new Date(),
        metadata: {
          subreddit: c.subreddit ?? null,
          score: c.score ?? null,
          source: "pullpush",
          kind: "comment",
        },
      });
    }

    return {
      platform: this.platform,
      mentions,
      queried: true,
      gaps: [],
      durationMs: 0,
    };
  }

  /* --------------------------------------------------------- Arctic Shift */

  private async viaArcticShift(
    keyword: string,
    options: ScrapeOptions
  ): Promise<ScrapeResult> {
    const url = new URL(this.arcticShift);
    url.searchParams.set("body", keyword);
    url.searchParams.set("limit", String(Math.min(options.limit ?? 50, 100)));
    url.searchParams.set("sort", "desc");
    if (options.since) {
      url.searchParams.set("after", String(Math.floor(options.since.getTime() / 1000)));
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(url.toString(), {
        headers: { Accept: "application/json", "User-Agent": this.userAgent },
        timeoutMs: options.timeoutMs ?? 30_000,
      });
    } catch (error) {
      return this.failed(`Arctic Shift unreachable: ${errorMessage(error)}`);
    }

    if (!response.ok) {
      return this.failed(`Arctic Shift returned HTTP ${response.status}`, response.status);
    }

    let payload: { data?: PullPushComment[] };
    try {
      payload = (await response.json()) as { data?: PullPushComment[] };
    } catch (error) {
      return this.failed(`Arctic Shift returned unparseable JSON: ${errorMessage(error)}`);
    }

    const mentions: CanonicalMention[] = [];
    for (const c of payload.data ?? []) {
      if (!c.id || !c.body) continue;
      if (!containsKeyword(c.body, keyword)) continue;

      const permalink =
        c.permalink ??
        `/comments/${String(c.link_id ?? "").replace(/^t3_/, "")}/_/${c.id}`;
      const { at, confidence } = parseDate(
        c.created_utc ? new Date(c.created_utc * 1000) : null
      );

      mentions.push({
        platform: this.platform,
        platformId: c.id,
        url: `https://www.reddit.com${permalink}`,
        author: c.author && c.author !== "[deleted]" ? c.author : undefined,
        content: c.body,
        publishedAt: at,
        dateConfidence: confidence,
        discoveredAt: new Date(),
        metadata: {
          subreddit: c.subreddit ?? null,
          score: c.score ?? null,
          source: "arctic-shift",
          kind: "comment",
        },
      });
    }

    return { platform: this.platform, mentions, queried: true, gaps: [], durationMs: 0 };
  }

  /* ------------------------------------------------------------- live RSS */

  private async viaRss(keyword: string, options: ScrapeOptions): Promise<ScrapeResult> {
    if (Date.now() < RedditAdapter.rssDisabledUntil) {
      return this.failed(
        `Reddit search RSS is disabled until ${new Date(
          RedditAdapter.rssDisabledUntil
        ).toISOString()} after a refusal. Retrying a source that has blocked you is how an ` +
          `IP gets banned outright.`,
        429
      );
    }

    const feedUrl =
      `${this.searchRss}?q=${encodeURIComponent(`"${keyword}"`)}&sort=new&t=week`;

    // Probe with a plain fetch first so a 403/429 is seen as a STATUS rather
    // than as an XML parse error, which is what rss-parser would report.
    let probe: Response;
    try {
      probe = await fetchWithTimeout(feedUrl, {
        headers: { "User-Agent": this.userAgent, Accept: "application/rss+xml, application/xml" },
        timeoutMs: options.timeoutMs ?? 25_000,
      });
    } catch (error) {
      return this.failed(`Reddit RSS unreachable: ${errorMessage(error)}`);
    }

    if (probe.status === 403 || probe.status === 429) {
      RedditAdapter.rssDisabledUntil = Date.now() + 24 * 3600_000;
      return this.failed(
        `Reddit refused anonymous RSS (HTTP ${probe.status}); disabled for 24h rather than retried.`,
        probe.status
      );
    }
    if (!probe.ok) {
      return this.failed(`Reddit RSS returned HTTP ${probe.status}`, probe.status);
    }

    let xml: string;
    try {
      xml = await probe.text();
    } catch (error) {
      return this.failed(`Reddit RSS body unreadable: ${errorMessage(error)}`);
    }

    /* rss-parser's default Item type has neither `id` nor `author` — Reddit's
     * Atom feed supplies both, so the custom-field types are declared rather
     * than reached for with `any`. */
    type RedditItem = { id?: string; author?: string };
    let feed: Parser.Output<RedditItem>;
    try {
      feed = await new Parser<Record<string, never>, RedditItem>({
        customFields: { item: ["id", "author"] },
      }).parseString(xml);
    } catch (error) {
      return this.failed(`Reddit RSS did not parse as a feed: ${errorMessage(error)}`);
    }

    const limit = options.limit ?? 25;
    const mentions: CanonicalMention[] = [];

    for (const item of (feed.items ?? []).slice(0, limit)) {
      const link = item.link ?? "";
      if (!link) continue;

      const content = [item.title, item.contentSnippet ?? item.content]
        .filter(Boolean)
        .join("\n\n");
      if (!containsKeyword(content, keyword)) continue;

      const { at, confidence } = parseDate(item.isoDate ?? item.pubDate);
      if (options.since && at && at < options.since) continue;

      mentions.push({
        platform: this.platform,
        // Reddit's Atom id is stable; the link is the fallback identity.
        platformId: item.id ?? link,
        url: link,
        author: item.author ?? undefined,
        content,
        publishedAt: at,
        dateConfidence: confidence,
        discoveredAt: new Date(),
        metadata: { source: "search-rss", kind: "post" },
      });
    }

    return { platform: this.platform, mentions, queried: true, gaps: [], durationMs: 0 };
  }

  private failed(reason: string, status?: number): ScrapeResult {
    return {
      platform: this.platform,
      mentions: [],
      queried: false,
      gaps: [{ reason, status, blocked: status === 403 || status === 429 }],
      durationMs: 0,
    };
  }
}

interface PullPushComment {
  id?: string;
  body?: string;
  author?: string;
  subreddit?: string;
  score?: number;
  permalink?: string;
  link_id?: string;
  created_utc?: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "request timed out" : error.message;
  }
  return String(error);
}
