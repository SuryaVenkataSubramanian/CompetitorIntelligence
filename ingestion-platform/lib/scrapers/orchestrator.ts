import type { PrismaClient, TrackedProduct } from "@prisma/client";
import { SearXNGAdapter } from "./adapters/searxng";
import { BlueskyAdapter } from "./adapters/bluesky";
import { HackerNewsAdapter } from "./adapters/hackernews";
import { RedditAdapter } from "./adapters/reddit";
import { LinkedInVoyagerAdapter } from "./adapters/linkedin";
import { GoogleAIOAdapter } from "./adapters/google-aio";
import { IngestionEngine, IngestSummary } from "./engine";
import { ScrapeResult, ScraperAdapter, ScrapeOptions } from "./types";

/**
 * Plane-aware orchestration.
 *
 * The planes are split by WHERE THEY CAN RUN, which is the only split that
 * matters operationally:
 *
 *   public    keyless HTTP. Fast, safe, runs anywhere including Vercel edge.
 *             Executed concurrently — they do not contend for anything.
 *   headless  Chromium. Slow and memory-hungry, and Google challenges cloud
 *             IPs. Isolated with a hard 20s budget so it cannot take the run
 *             with it.
 *   auth      session-backed. Off unless credentials exist. Runs LAST so a
 *             checkpoint challenge never delays the results that already work.
 *
 * Every plane is wrapped so a failure in one cannot lose another's output. That
 * is not defensive coding for its own sake: the authenticated plane's expected
 * steady state is failure (§11), so the design has to assume it.
 */

export interface CrawlOptions extends ScrapeOptions {
  /** Skip the headless plane — it is the slowest and the least reliable. */
  includeHeadless?: boolean;
  /** Skip the authenticated plane even if credentials are present. */
  includeAuthenticated?: boolean;
}

export interface CrawlOutcome {
  productId: string;
  keyword: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  summary: IngestSummary;
  queriedPlatforms: string[];
  /** Unqueried sources. NEVER conflate these with zero results. */
  gaps: Array<{ platform: string; reason: string; blocked?: boolean }>;
}

/** Keyless adapters. Safe to run from a serverless function. */
export function publicPlane(): ScraperAdapter[] {
  return [new SearXNGAdapter(), new BlueskyAdapter(), new HackerNewsAdapter(), new RedditAdapter()];
}

export async function runCrawl(
  prisma: PrismaClient,
  product: TrackedProduct,
  options: CrawlOptions = {}
): Promise<CrawlOutcome> {
  const startedAt = new Date();
  const keyword = product.name;
  const engine = new IngestionEngine(prisma);
  const settled: PromiseSettledResult<ScrapeResult>[] = [];

  /* ------------------------------------------------- 1. public plane */

  const publicAdapters = publicPlane().filter((adapter) => {
    const gate = adapter.available();
    if (!gate.ok) {
      settled.push({
        status: "fulfilled",
        value: {
          platform: adapter.platform,
          mentions: [],
          queried: false,
          gaps: [{ reason: gate.reason ?? "not configured" }],
          durationMs: 0,
        },
      });
      return false;
    }
    return true;
  });

  settled.push(
    ...(await Promise.allSettled(
      publicAdapters.map((adapter) =>
        adapter.scrape(keyword, { limit: options.limit ?? 50, since: options.since })
      )
    ))
  );

  /* ---------------------------------------------- 2. headless plane */

  if (options.includeHeadless !== false) {
    settled.push(
      ...(await Promise.allSettled([
        new GoogleAIOAdapter().scrape(keyword, { timeoutMs: 20_000 }),
      ]))
    );
  }

  /* ----------------------------------------- 3. authenticated plane */

  /* Runs LAST and only on request. With no cookies the LinkedIn adapter still
   * returns public posts through SERP dorking, so the channel is covered either
   * way — the escalation buys reactions and commenter lists, and costs the §11
   * account risk. Default is the safe path. */
  if (options.includeAuthenticated) {
    settled.push(
      ...(await Promise.allSettled([
        new LinkedInVoyagerAdapter().scrape(keyword, {
          limit: options.limit ?? 25,
          since: options.since,
        }),
      ]))
    );
  } else {
    // Still collect public LinkedIn posts — just without a session.
    settled.push(
      ...(await Promise.allSettled([
        new SearXNGAdapter().scrapeLinkedInMentions(keyword, { limit: options.limit ?? 25 }),
      ]))
    );
  }

  /* -------------------------------------------------- 4. ingest */

  const { mentions, gaps, queriedPlatforms } = IngestionEngine.flatten(settled);
  const summary = await engine.processBatch(mentions, product);
  const finishedAt = new Date();

  return {
    productId: product.id,
    keyword,
    startedAt,
    finishedAt,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    summary,
    queriedPlatforms,
    gaps,
  };
}
