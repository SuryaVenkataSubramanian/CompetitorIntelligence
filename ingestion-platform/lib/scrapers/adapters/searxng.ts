import {
  CanonicalMention,
  ScrapeOptions,
  ScrapeResult,
  ScraperAdapter,
  ScrapeGap,
  fetchWithTimeout,
  parseDate,
  unavailable,
} from "../types";

/**
 * SearXNG — federated metasearch over one JSON endpoint.
 *
 * Two endpoints, and deliberately nothing more:
 *   GET /search?q=...&format=json    results
 *   GET /                            liveness
 *
 * It replaces direct Google/Bing fetching (immediate 429/403 from cloud IP
 * ranges) and `duck-duck-scrape` (dead on DuckDuckGo's VQD token churn).
 * DuckDuckGo remains reachable as one of SearXNG's upstream engines, which is
 * the point: the instance owns engine-specific breakage, not this code.
 *
 * REQUIRES `formats: [html, json]` under `search:` in settings.yml. A stock
 * instance serves HTML only and answers a JSON request with 403, which is the
 * single most common misconfiguration and is reported explicitly below rather
 * than surfacing as an empty result.
 */
export class SearXNGAdapter implements ScraperAdapter {
  public readonly platform = "SEARXNG" as const;
  private readonly baseUrl: string;

  constructor(baseUrl: string = process.env.SEARXNG_BASE_URL ?? "") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  available(): { ok: boolean; reason?: string } {
    if (!this.baseUrl) {
      return {
        ok: false,
        reason:
          "SEARXNG_BASE_URL is not set. SearXNG is the only keyless route to general web " +
          "search; without it the web plane is unavailable rather than empty.",
      };
    }
    return { ok: true };
  }

  /**
   * One phrase per query, always quoted.
   *
   * An unquoted multi-word keyword is matched word-by-word by most upstream
   * engines, which returns documents containing only "knowledge" for a query of
   * "knowledge base". Quoting is what makes the result set a mention set.
   */
  async scrape(keyword: string, options: ScrapeOptions = {}): Promise<ScrapeResult> {
    const gate = this.available();
    if (!gate.ok) return unavailable(this.platform, gate.reason!);
    return this.query(`"${keyword}"`, keyword, options);
  }

  /**
   * SERP dorking for LinkedIn.
   *
   * This is the highest-leverage adapter in the suite. It reaches public
   * LinkedIn posts through a public index, so it needs no account, cannot get
   * one banned, and carries none of the §11 ToS exposure of the Voyager path.
   * The spec's own risk register recommends it as the default and Voyager as
   * the opt-in escalation; this implementation follows that.
   */
  async scrapeLinkedInMentions(
    keyword: string,
    options: ScrapeOptions = {}
  ): Promise<ScrapeResult> {
    const gate = this.available();
    if (!gate.ok) return unavailable("LINKEDIN", gate.reason!);

    const result = await this.query(
      `site:linkedin.com/posts "${keyword}"`,
      keyword,
      options
    );

    // Re-stamp as LinkedIn: the mentions are LinkedIn posts that happened to be
    // discovered through a search index, and filing them under SEARXNG would
    // leave the LinkedIn channel reading zero while its data sat elsewhere.
    return {
      ...result,
      platform: "LINKEDIN",
      mentions: result.mentions
        .filter((m) => /linkedin\.com\/posts/i.test(m.url))
        .map((m) => ({
          ...m,
          platform: "LINKEDIN" as const,
          author: extractLinkedInAuthor(m.url, String(m.metadata?.title ?? "")),
          metadata: { ...m.metadata, discoveredVia: "searxng-serp-dork" },
        })),
    };
  }

  private async query(
    q: string,
    keyword: string,
    options: ScrapeOptions
  ): Promise<ScrapeResult> {
    const started = Date.now();
    const limit = options.limit ?? 50;
    const gaps: ScrapeGap[] = [];

    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set("q", q);
    url.searchParams.set("format", "json");
    url.searchParams.set("categories", "general,it,news");
    url.searchParams.set("language", "en");
    url.searchParams.set("safesearch", "0");

    let response: Response;
    try {
      response = await fetchWithTimeout(url.toString(), {
        headers: { Accept: "application/json" },
        timeoutMs: options.timeoutMs ?? 45_000,
      });
    } catch (error) {
      return {
        platform: this.platform,
        mentions: [],
        queried: false,
        gaps: [
          {
            reason: `SearXNG unreachable at ${this.baseUrl}: ${errorMessage(error)}`,
            blocked: false,
          },
        ],
        durationMs: Date.now() - started,
      };
    }

    if (response.status === 403) {
      return {
        platform: this.platform,
        mentions: [],
        queried: false,
        gaps: [
          {
            status: 403,
            blocked: true,
            reason:
              "SearXNG returned 403 for a JSON request. The instance almost certainly serves " +
              "HTML only — add `json` to `search.formats` in settings.yml and restart.",
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
        gaps: [{ status: response.status, reason: `SearXNG returned HTTP ${response.status}` }],
        durationMs: Date.now() - started,
      };
    }

    let payload: SearXNGResponse;
    try {
      payload = (await response.json()) as SearXNGResponse;
    } catch (error) {
      return {
        platform: this.platform,
        mentions: [],
        queried: false,
        gaps: [
          {
            reason:
              "SearXNG returned a non-JSON body despite HTTP 200 — enable `json` in " +
              `search.formats. (${errorMessage(error)})`,
          },
        ],
        durationMs: Date.now() - started,
      };
    }

    // Unresponsive engines are PARTIAL COVERAGE, not failure. Reporting them is
    // what stops a thin result set reading as a quiet week.
    for (const engine of payload.unresponsive_engines ?? []) {
      const name = Array.isArray(engine) ? engine.join(": ") : String(engine);
      gaps.push({ reason: `upstream engine did not answer: ${name}` });
    }

    const mentions: CanonicalMention[] = [];
    for (const item of (payload.results ?? []).slice(0, limit)) {
      if (!item.url) continue;
      const title = item.title ?? "";
      const body = item.content ?? "";
      const content = [title, body].filter(Boolean).join("\n\n");
      if (!content.trim()) continue;

      const { at, confidence } = parseDate(item.publishedDate);

      mentions.push({
        platform: this.platform,
        // The URL is the only stable identifier a SERP result has.
        platformId: canonicalUrl(item.url),
        url: item.url,
        author: undefined,
        content,
        publishedAt: at,
        dateConfidence: confidence,
        discoveredAt: new Date(),
        metadata: {
          title,
          engine: item.engine ?? null,
          score: item.score ?? null,
          keyword,
        },
      });
    }

    return {
      platform: this.platform,
      mentions,
      queried: true,
      gaps,
      durationMs: Date.now() - started,
    };
  }
}

/* ------------------------------------------------------------------ helpers */

interface SearXNGResponse {
  results?: Array<{
    url?: string;
    title?: string;
    content?: string;
    engine?: string;
    score?: number;
    publishedDate?: string | null;
  }>;
  unresponsive_engines?: Array<string | string[]>;
}

/** Strip tracking parameters so the same page is one identity, not many. */
function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const drop = [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "ref_src",
    ];
    for (const p of drop) u.searchParams.delete(p);
    u.hash = "";
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * LinkedIn post URLs embed the poster's profile handle:
 *   /posts/<author-handle>_<topic-slug>-activity-<id>
 *
 * Returns undefined rather than a guess when the handle is not name-shaped — a
 * handle like `saravanamv` is one token that could be anything, and an invented
 * author on a real post is worse than a blank field.
 */
function extractLinkedInAuthor(url: string, title: string): string | undefined {
  const fromTitle = /^(.+?)(?:'|’)s\s+Post\b/i.exec(title);
  if (fromTitle) return fromTitle[1].trim();

  try {
    const segment = decodeURIComponent(new URL(url).pathname).split("/posts/")[1] ?? "";
    const handle = segment.split("_")[0] ?? "";
    const parts = handle.split("-").filter((w) => /^[\p{L}]{2,}$/u.test(w));
    if (parts.length < 2) return undefined;
    return parts
      .slice(0, 3)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "request timed out" : error.message;
  }
  return String(error);
}
