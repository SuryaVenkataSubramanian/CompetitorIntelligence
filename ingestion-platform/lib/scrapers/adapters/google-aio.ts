import puppeteer, { Browser } from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import {
  CanonicalMention,
  ScrapeOptions,
  ScrapeResult,
  ScraperAdapter,
} from "../types";

/**
 * Google AI Overviews — headless Chromium with text-node heuristics.
 *
 * Static parsers (Cheerio, axios) never see this content: Gemini synthesizes the
 * Overview asynchronously and injects it client-side, so the initial HTML has no
 * container at all. That is why `div.Fzsovc` / `div.YzCcne` selectors from
 * tutorials return nothing — not because the class changed, but because the
 * whole subtree arrives after load.
 *
 * DETECTION IS BY TEXT NODE, NOT BY CLASS. The obfuscated class names rotate
 * across Google's data centres and UI experiments, so `div.Kevs9` is treated as
 * a confirmation hint and never as the primary selector. The stable signal is
 * the literal heading "AI Overview".
 *
 * A NOTE ON WHERE THIS CAN RUN. @sparticuz/chromium exists to fit Chromium into
 * a Lambda layer, and it does. It does not fix the other half of the problem:
 * Google serves CAPTCHA interstitials to AWS IP ranges at a high rate, so this
 * adapter is markedly less reliable on Vercel than on a VPS with a residential
 * egress. It reports a challenge as a GAP rather than as an empty Overview,
 * which is the distinction that keeps "Google shows no AI Overview for this
 * brand" from being a lie.
 */
export class GoogleAIOAdapter implements ScraperAdapter {
  public readonly platform = "GOOGLE_AIO" as const;

  /** Hard ceiling for the whole browser lifecycle, per the spec's Phase 4. */
  private static readonly HARD_TIMEOUT_MS = 20_000;

  available(): { ok: boolean; reason?: string } {
    return { ok: true };
  }

  async scrape(keyword: string, options: ScrapeOptions = {}): Promise<ScrapeResult> {
    const started = Date.now();
    const budget = Math.min(options.timeoutMs ?? GoogleAIOAdapter.HARD_TIMEOUT_MS,
      GoogleAIOAdapter.HARD_TIMEOUT_MS);

    const isLambda = Boolean(
      process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_VERSION
    );

    let browser: Browser | null = null;
    const targetUrl =
      `https://www.google.com/search?q=${encodeURIComponent(keyword)}&hl=en&gl=us`;

    try {
      const executablePath = isLambda
        ? await chromium.executablePath()
        : process.env.LOCAL_CHROMIUM_PATH ?? "/usr/bin/google-chrome";

      browser = await puppeteer.launch({
        args: isLambda
          ? chromium.args
          : ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        defaultViewport: { width: 1280, height: 900 },
        executablePath,
        headless: true,
      });

      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
      );
      // Images and fonts are pure cost here; the Overview is text and links.
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const type = req.resourceType();
        if (type === "image" || type === "font" || type === "media") req.abort().catch(() => {});
        else req.continue().catch(() => {});
      });

      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: budget });

      // A CAPTCHA is a 200 with a form. Detecting it FIRST means it is reported
      // as a block rather than as "no Overview exists".
      const challenged = await page.evaluate(() => {
        const body = document.body?.innerText ?? "";
        return (
          /our systems have detected unusual traffic|not a robot|recaptcha/i.test(body) ||
          Boolean(document.querySelector("form#captcha-form, div.g-recaptcha"))
        );
      });
      if (challenged) {
        return {
          platform: this.platform,
          mentions: [],
          queried: false,
          gaps: [
            {
              blocked: true,
              reason:
                "Google served a CAPTCHA interstitial. This is the expected response to a cloud " +
                "IP range; it is NOT evidence that no AI Overview exists for this query. Run this " +
                "adapter from a residential egress if the signal matters.",
            },
          ],
          durationMs: Date.now() - started,
        };
      }

      // The Overview is injected after load. Poll for the heading rather than
      // sleeping a fixed interval, and give up inside the budget.
      const appeared = await page
        .waitForFunction(
          () =>
            Array.from(document.querySelectorAll("h1, h2, h3, div, span")).some(
              (el) => el.textContent?.trim() === "AI Overview"
            ),
          { timeout: Math.max(2_000, budget - (Date.now() - started)), polling: 250 }
        )
        .then(() => true)
        .catch(() => false);

      if (!appeared) {
        return {
          platform: this.platform,
          mentions: [],
          // The page loaded and we looked. No Overview is a REAL answer here,
          // and a genuine competitive signal in its own right.
          queried: true,
          gaps: [],
          durationMs: Date.now() - started,
        };
      }

      const extracted = await page.evaluate(() => {
        const heading = Array.from(
          document.querySelectorAll("h1, h2, h3, div, span")
        ).find((el) => el.textContent?.trim() === "AI Overview");
        if (!heading) return null;

        // Walk up until the container is large enough to be the module rather
        // than the label. The class check is a confirmation, not the selector.
        let container: HTMLElement | null = heading as HTMLElement;
        let best: HTMLElement | null = null;
        for (let i = 0; i < 10 && container?.parentElement; i++) {
          container = container.parentElement;
          const text = container.innerText ?? "";
          if (text.length > 160) best = best ?? container;
          if (
            container.classList.contains("Kevs9") ||
            container.getAttribute("data-attrid")?.includes("overview")
          ) {
            best = container;
            break;
          }
        }
        const node = best ?? container;
        if (!node) return null;

        const citations = Array.from(node.querySelectorAll<HTMLAnchorElement>("a[href]"))
          .map((a) => a.href)
          .filter((href) => /^https?:/i.test(href) && !/google\.[a-z.]+\//i.test(href));

        const summary = (node.innerText ?? "").replace(/^AI Overview\s*/i, "").trim();
        return { summary, citations: Array.from(new Set(citations)) };
      });

      if (!extracted?.summary) {
        return {
          platform: this.platform,
          mentions: [],
          queried: true,
          gaps: [
            {
              reason:
                'The "AI Overview" heading was present but no summary text could be extracted. ' +
                "Google's container structure has probably changed — this is a parser fault, " +
                "not an absent Overview, and must not be counted as a zero.",
            },
          ],
          durationMs: Date.now() - started,
        };
      }

      return {
        platform: this.platform,
        mentions: [
          {
            platform: this.platform,
            /* STABLE ACROSS RUNS, deliberately.
             *
             * The specification builds this id with `Date.now()`, which makes
             * every run produce a new primary key: dedupe can never fire, and
             * one query a day becomes 365 rows a year describing the same
             * module. Keying on the query alone means re-running updates the
             * same record, and a changed summary is visible as an edit rather
             * than as a new mention. */
            platformId: `google-aio:${normalizeQuery(keyword)}`,
            url: targetUrl,
            author: "Google AI Overview",
            content: extracted.summary,
            // Google publishes no timestamp for a generated Overview. The
            // honest value is null plus the time we observed it.
            publishedAt: null,
            dateConfidence: "unknown",
            discoveredAt: new Date(),
            metadata: {
              citations: extracted.citations,
              citationCount: extracted.citations.length,
              query: keyword,
              generated: true,
            },
          },
        ],
        queried: true,
        gaps: [],
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        platform: this.platform,
        mentions: [],
        queried: false,
        gaps: [{ reason: `Google AI Overview extraction failed: ${errorMessage(error)}` }],
        durationMs: Date.now() - started,
      };
    } finally {
      // A leaked Chromium on a warm Lambda exhausts memory across invocations.
      if (browser) await browser.close().catch(() => {});
    }
  }
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, "-");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" ? "timed out" : error.message;
  }
  return String(error);
}
