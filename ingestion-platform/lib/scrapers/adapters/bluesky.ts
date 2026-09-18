import {
  CanonicalMention,
  ScrapeOptions,
  ScrapeResult,
  ScraperAdapter,
  fetchWithTimeout,
  parseDate,
} from "../types";

/**
 * Bluesky — AT Protocol public AppView.
 *
 * The best source in this suite, and the reason is structural rather than
 * incidental: Bluesky's protocol is designed for public consumption, so there
 * is no credential, no session to rot, no fingerprinting, and no ToS exposure.
 * Everything the authenticated X plane costs in §11 maintenance, this gives
 * away.
 *
 * It replaces the X API v2 client for COVERAGE purposes, and the replacement is
 * honest about what it is: Bluesky is a different network with a different
 * population, not a mirror of X. Treating it as an X substitute overstates the
 * coverage; treating it as free microblog coverage understates it.
 */
export class BlueskyAdapter implements ScraperAdapter {
  public readonly platform = "BLUESKY" as const;
  private readonly endpoint =
    "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts";

  available(): { ok: boolean; reason?: string } {
    // No credential, no configuration. It is always available.
    return { ok: true };
  }

  async scrape(keyword: string, options: ScrapeOptions = {}): Promise<ScrapeResult> {
    const started = Date.now();
    const limit = Math.min(options.limit ?? 50, 100); // API caps at 100

    const url = new URL(this.endpoint);
    url.searchParams.set("q", keyword);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("sort", "latest");
    if (options.since) {
      // The AppView accepts an ISO 8601 date; this bounds the window server-side
      // rather than fetching everything and discarding most of it.
      url.searchParams.set("since", options.since.toISOString());
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(url.toString(), {
        headers: { Accept: "application/json" },
        timeoutMs: options.timeoutMs ?? 20_000,
      });
    } catch (error) {
      return {
        platform: this.platform,
        mentions: [],
        queried: false,
        gaps: [{ reason: `Bluesky XRPC unreachable: ${errorMessage(error)}` }],
        durationMs: Date.now() - started,
      };
    }

    if (response.status === 429) {
      return {
        platform: this.platform,
        mentions: [],
        queried: false,
        gaps: [
          {
            status: 429,
            blocked: true,
            reason:
              "Bluesky rate limited this client. The AppView limits by burst rather than by " +
              "quota, so spacing requests resolves it; there is no paid tier to buy.",
          },
        ],
        durationMs: Date.now() - started,
      };
    }

    if (!response.ok) {
      return {
        platform: this.platform,
        mentions: [],
        queried: false,
        gaps: [{ status: response.status, reason: `Bluesky XRPC returned HTTP ${response.status}` }],
        durationMs: Date.now() - started,
      };
    }

    let payload: BlueskySearchResponse;
    try {
      payload = (await response.json()) as BlueskySearchResponse;
    } catch (error) {
      return {
        platform: this.platform,
        mentions: [],
        queried: false,
        gaps: [{ reason: `Bluesky returned unparseable JSON: ${errorMessage(error)}` }],
        durationMs: Date.now() - started,
      };
    }

    const mentions: CanonicalMention[] = [];
    for (const post of payload.posts ?? []) {
      const uri = post.uri;
      if (!uri) continue;

      const text = post.record?.text ?? "";
      if (!text.trim()) continue;

      const handle = post.author?.handle ?? post.author?.did;
      if (!handle) continue;

      // at://did:plc:xyz/app.bsky.feed.post/<rkey>  ->  bsky.app/profile/<handle>/post/<rkey>
      const rkey = uri.split("/").pop();
      if (!rkey) continue;

      // createdAt is self-reported by the posting client and is occasionally
      // wrong or absent; indexedAt is the AppView's own observation. Prefer the
      // claim, fall back to the observation, and never fabricate.
      const created = parseDate(post.record?.createdAt);
      const indexed = parseDate(post.indexedAt);
      const at = created.at ?? indexed.at;
      const confidence = created.at
        ? created.confidence
        : indexed.at
          ? "approximate"
          : "unknown";

      mentions.push({
        platform: this.platform,
        // cid is the content hash and changes if the post is edited; uri is the
        // stable identity of the post itself, so that is the platformId.
        platformId: uri,
        url: `https://bsky.app/profile/${handle}/post/${rkey}`,
        author: post.author?.displayName || handle,
        authorUrl: `https://bsky.app/profile/${handle}`,
        content: text,
        publishedAt: at,
        dateConfidence: confidence,
        discoveredAt: new Date(),
        metadata: {
          cid: post.cid ?? null,
          did: post.author?.did ?? null,
          handle,
          likeCount: post.likeCount ?? 0,
          repostCount: post.repostCount ?? 0,
          replyCount: post.replyCount ?? 0,
          quoteCount: post.quoteCount ?? 0,
          langs: post.record?.langs ?? [],
        },
      });
    }

    return {
      platform: this.platform,
      mentions,
      queried: true,
      gaps: [],
      durationMs: Date.now() - started,
    };
  }
}

interface BlueskySearchResponse {
  posts?: Array<{
    uri?: string;
    cid?: string;
    indexedAt?: string;
    likeCount?: number;
    repostCount?: number;
    replyCount?: number;
    quoteCount?: number;
    author?: { did?: string; handle?: string; displayName?: string };
    record?: { text?: string; createdAt?: string; langs?: string[] };
  }>;
  cursor?: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "request timed out" : error.message;
  }
  return String(error);
}
