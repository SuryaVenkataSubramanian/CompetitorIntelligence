import {
  CanonicalMention,
  ScrapeOptions,
  ScrapeResult,
  ScraperAdapter,
  fetchWithTimeout,
  parseDate,
} from "../types";
import { SearXNGAdapter } from "./searxng";

/**
 * LinkedIn — Voyager with an automatic SERP-dorking fallback.
 *
 * READ THIS BEFORE ENABLING THE VOYAGER PATH
 * ------------------------------------------
 * The specification's own §11 risk register recommends skipping the
 * authenticated plane entirely, and this implementation agrees with it. Voyager
 * is therefore OFF BY DEFAULT: with no cookies configured, this adapter is a
 * thin wrapper over SearXNG dorking, which needs no account and cannot get one
 * banned.
 *
 * What enabling it actually costs, from §11:
 *   - Account suspension is the expected steady state, not a risk. Use a burner.
 *   - It breaches the ToS you accepted at signup. That is contractual, and no
 *     amount of proxy rotation changes it.
 *   - Protocols rotate every 2-4 weeks; Voyager paths rot.
 *   - Author names and post bodies from EU/UK subjects are personal data under
 *     GDPR whether or not they were public.
 *
 * THE CSRF QUOTE BUG, which is the single most common reason this returns 403:
 * LinkedIn stores JSESSIONID wrapped in literal double quotes — `"ajax:1234"`.
 * The `cookie` header must KEEP the quotes; the `csrf-token` header must have
 * them STRIPPED. Sending either one in the other's form is a 403 with no useful
 * body. Handled in the constructor, once, so no call site can get it wrong.
 */
export class LinkedInVoyagerAdapter implements ScraperAdapter {
  public readonly platform = "LINKEDIN" as const;

  /** Quoted form, for the cookie header. */
  private readonly jsessionQuoted: string;
  /** Unquoted form, for the csrf-token header. */
  private readonly jsessionBare: string;
  private readonly liAt: string;
  private readonly fallback: SearXNGAdapter;

  constructor(
    liAt: string = process.env.LINKEDIN_LI_AT ?? "",
    jsessionId: string = process.env.LINKEDIN_JSESSIONID ?? "",
    fallback: SearXNGAdapter = new SearXNGAdapter()
  ) {
    this.liAt = liAt.trim();

    const bare = jsessionId.trim().replace(/^"+|"+$/g, "");
    this.jsessionBare = bare;
    this.jsessionQuoted = bare ? `"${bare}"` : "";
    this.fallback = fallback;
  }

  /**
   * Always available: with no session it degrades to dorking rather than
   * reporting itself disconnected. A channel that has a working keyless route
   * is not disconnected just because its optional escalation is unconfigured.
   */
  available(): { ok: boolean; reason?: string } {
    return { ok: true };
  }

  private hasSession(): boolean {
    return Boolean(this.liAt && this.jsessionBare);
  }

  async scrape(keyword: string, options: ScrapeOptions = {}): Promise<ScrapeResult> {
    const started = Date.now();

    if (!this.hasSession()) {
      const result = await this.fallback.scrapeLinkedInMentions(keyword, options);
      return {
        ...result,
        gaps: [
          ...result.gaps,
          {
            reason:
              "Voyager is not configured (LINKEDIN_LI_AT / LINKEDIN_JSESSIONID unset), so public " +
              "posts were collected through SERP dorking instead. This is the recommended default — " +
              "see §11. Voyager adds reactions and commenter lists at the cost of account risk.",
          },
        ],
        durationMs: Date.now() - started,
      };
    }

    const url =
      "https://www.linkedin.com/voyager/api/graphql" +
      "?queryId=voyagerSearchDashClusters.search" +
      `&variables=(keywords:${encodeURIComponent(keyword)})`;

    let response: Response;
    try {
      response = await fetchWithTimeout(url, {
        headers: {
          // STRIPPED of quotes. See the class comment.
          "csrf-token": this.jsessionBare,
          // QUOTES PRESERVED. See the class comment.
          cookie: `JSESSIONID=${this.jsessionQuoted}; li_at=${this.liAt};`,
          "x-restli-protocol-version": "2.0.0",
          "x-li-lang": "en_US",
          accept: "application/vnd.linkedin.normalized+json+2.1",
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        },
        timeoutMs: options.timeoutMs ?? 20_000,
      });
    } catch (error) {
      return this.withFallback(
        keyword,
        options,
        started,
        `Voyager request failed (${errorMessage(error)})`
      );
    }

    // 401/403 is a checkpoint challenge or an invalidated session. It is not
    // retryable and it will not resolve on its own.
    if (response.status === 401 || response.status === 403) {
      return this.withFallback(
        keyword,
        options,
        started,
        `Voyager returned ${response.status} — the session is invalid or LinkedIn issued a ` +
          `checkpoint challenge. Re-export li_at and JSESSIONID from a signed-in browser. ` +
          `If this recurs within days, the account is being flagged.`,
        response.status
      );
    }

    if (response.status === 429) {
      return this.withFallback(
        keyword,
        options,
        started,
        "Voyager rate limited this session (429). Account-level ceilings are per-account and " +
          "are not solved by proxies.",
        429
      );
    }

    if (!response.ok) {
      return this.withFallback(
        keyword,
        options,
        started,
        `Voyager returned HTTP ${response.status}`,
        response.status
      );
    }

    let payload: VoyagerResponse;
    try {
      payload = (await response.json()) as VoyagerResponse;
    } catch (error) {
      return this.withFallback(
        keyword,
        options,
        started,
        `Voyager returned unparseable JSON (${errorMessage(error)}) — the normalized+json ` +
          `schema has probably changed.`
      );
    }

    const limit = options.limit ?? 25;
    const mentions: CanonicalMention[] = [];

    for (const element of payload.included ?? []) {
      const text =
        element.commentary?.text?.text ??
        element.summary?.text ??
        element.title?.text ??
        "";
      const urn = element.entityUrn ?? element.urn;
      if (!text.trim() || !urn) continue;

      // Voyager exposes createdTime inconsistently across element types, and an
      // absent one must not become "now".
      const { at, confidence } = parseDate(
        element.createdTime ?? element.actor?.subDescription?.text ?? null
      );

      mentions.push({
        platform: this.platform,
        platformId: urn,
        url: `https://www.linkedin.com/feed/update/${urn}`,
        author: element.actor?.name?.text ?? undefined,
        authorUrl: element.actor?.navigationContext?.actionTarget ?? undefined,
        content: text,
        publishedAt: at,
        dateConfidence: confidence,
        discoveredAt: new Date(),
        metadata: { urn, source: "voyager", authBacked: true },
      });

      if (mentions.length >= limit) break;
    }

    return {
      platform: this.platform,
      mentions,
      queried: true,
      gaps: [],
      durationMs: Date.now() - started,
    };
  }

  /**
   * Fall back to dorking and keep BOTH explanations.
   *
   * The reason Voyager failed is not noise to be swallowed — a 403 today and a
   * 403 next week mean the account is being flagged, and that is only visible
   * if the reason survives the fallback.
   */
  private async withFallback(
    keyword: string,
    options: ScrapeOptions,
    started: number,
    reason: string,
    status?: number
  ): Promise<ScrapeResult> {
    const result = await this.fallback.scrapeLinkedInMentions(keyword, options);
    return {
      ...result,
      gaps: [
        { reason, status, blocked: status === 401 || status === 403 || status === 429 },
        ...result.gaps,
      ],
      durationMs: Date.now() - started,
    };
  }
}

interface VoyagerElement {
  entityUrn?: string;
  urn?: string;
  createdTime?: number | string;
  commentary?: { text?: { text?: string } };
  summary?: { text?: string };
  title?: { text?: string };
  actor?: {
    name?: { text?: string };
    subDescription?: { text?: string };
    navigationContext?: { actionTarget?: string };
  };
}

interface VoyagerResponse {
  included?: VoyagerElement[];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "request timed out" : error.message;
  }
  return String(error);
}
