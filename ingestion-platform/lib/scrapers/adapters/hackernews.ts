import {
  CanonicalMention,
  ScrapeOptions,
  ScrapeResult,
  ScraperAdapter,
  containsKeyword,
  fetchWithTimeout,
  parseDate,
} from "../types";

/**
 * Hacker News — Algolia search, keyless.
 *
 * THE TRAP THIS ADAPTER EXISTS TO AVOID
 * -------------------------------------
 * Algolia is TYPO-TOLERANT. A query for `GitBook` returns hits for "netbook"
 * and "GifBook", and it returns them with the same shape and confidence as a
 * real match. Quoting the query reduces it; it does not eliminate it.
 *
 * So every hit is post-filtered on a literal whole-word match against the
 * keyword. The spec does not do this, and its Tier-3 relevance fallback uses
 * `String.includes`, which would not catch it downstream either — "netbook"
 * does not contain "gitbook", but "GitBookies" would pass a substring test
 * while failing a word-boundary one.
 *
 * The consequence of getting this right: a zero-hit week is a TRUE zero, and
 * can be reported as one.
 */
export class HackerNewsAdapter implements ScraperAdapter {
  public readonly platform = "HACKERNEWS" as const;
  private readonly endpoint = "https://hn.algolia.com/api/v1/search_by_date";

  available(): { ok: boolean; reason?: string } {
    return { ok: true };
  }

  async scrape(keyword: string, options: ScrapeOptions = {}): Promise<ScrapeResult> {
    const started = Date.now();
    const limit = Math.min(options.limit ?? 50, 1000);

    const url = new URL(this.endpoint);
    url.searchParams.set("query", `"${keyword}"`);
    url.searchParams.set("tags", "(story,comment)");
    url.searchParams.set("hitsPerPage", String(limit));
    // Restrict the searchable attributes so a match on an unrelated indexed
    // field (author name, URL) does not surface as a content mention.
    url.searchParams.set(
      "restrictSearchableAttributes",
      "comment_text,story_text,title"
    );
    if (options.since) {
      url.searchParams.set(
        "numericFilters",
        `created_at_i>${Math.floor(options.since.getTime() / 1000)}`
      );
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
        gaps: [{ reason: `HN Algolia unreachable: ${errorMessage(error)}` }],
        durationMs: Date.now() - started,
      };
    }

    if (!response.ok) {
      return {
        platform: this.platform,
        mentions: [],
        queried: false,
        gaps: [{ status: response.status, reason: `HN Algolia returned HTTP ${response.status}` }],
        durationMs: Date.now() - started,
      };
    }

    let payload: AlgoliaResponse;
    try {
      payload = (await response.json()) as AlgoliaResponse;
    } catch (error) {
      return {
        platform: this.platform,
        mentions: [],
        queried: false,
        gaps: [{ reason: `HN Algolia returned unparseable JSON: ${errorMessage(error)}` }],
        durationMs: Date.now() - started,
      };
    }

    const mentions: CanonicalMention[] = [];
    let typoRejected = 0;

    for (const hit of payload.hits ?? []) {
      const objectId = hit.objectID;
      if (!objectId) continue;

      const content = [hit.title, hit.story_title, hit.story_text, hit.comment_text]
        .filter(Boolean)
        .join("\n\n");
      if (!content.trim()) continue;

      // THE TYPO FILTER. See the class comment.
      if (!containsKeyword(content, keyword)) {
        typoRejected++;
        continue;
      }

      const { at, confidence } = parseDate(hit.created_at);
      const isComment = Boolean(hit.comment_text);
      // Comments live under their story's thread; stories are their own item.
      const threadId = hit.story_id ?? objectId;

      mentions.push({
        platform: this.platform,
        platformId: String(objectId),
        // Canonical URL points at the HN item, never at the Algolia record and
        // never at the story's external link — the mention is the HN post.
        url: `https://news.ycombinator.com/item?id=${objectId}`,
        author: hit.author ?? undefined,
        authorUrl: hit.author
          ? `https://news.ycombinator.com/user?id=${encodeURIComponent(hit.author)}`
          : undefined,
        content,
        publishedAt: at,
        dateConfidence: confidence,
        discoveredAt: new Date(),
        metadata: {
          type: isComment ? "comment" : "story",
          points: hit.points ?? null,
          numComments: hit.num_comments ?? null,
          threadUrl: `https://news.ycombinator.com/item?id=${threadId}`,
          externalUrl: hit.url ?? null,
        },
      });
    }

    return {
      platform: this.platform,
      mentions,
      queried: true,
      // Not a gap — the source answered. Recorded so the drop rate is visible,
      // because a sudden spike in typo rejections means the query is wrong.
      gaps: typoRejected
        ? [
            {
              reason:
                `${typoRejected} typo-tolerant near-miss(es) dropped — Algolia matched a similar ` +
                `word rather than "${keyword}". This is expected behaviour, not an error.`,
            },
          ]
        : [],
      durationMs: Date.now() - started,
    };
  }
}

interface AlgoliaResponse {
  hits?: Array<{
    objectID?: string;
    title?: string | null;
    story_title?: string | null;
    story_text?: string | null;
    comment_text?: string | null;
    author?: string | null;
    created_at?: string;
    points?: number | null;
    num_comments?: number | null;
    story_id?: number | string | null;
    url?: string | null;
  }>;
  nbHits?: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "request timed out" : error.message;
  }
  return String(error);
}
