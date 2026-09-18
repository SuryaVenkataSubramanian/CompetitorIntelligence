import crypto from "crypto";
import type { PrismaClient, TrackedProduct } from "@prisma/client";
import {
  CanonicalMention,
  ScrapeResult,
  containsKeyword,
  fetchWithTimeout,
} from "./types";

export interface RelevanceVerdict {
  isRelevant: boolean;
  score: number;
  /** Which tier decided. Auditable — a score with no provenance is a vibe.
   *  These values are the Prisma `RelevanceMethod` enum verbatim: Prisma enum
   *  members cannot contain hyphens, so kebab-case here would fail to compile
   *  against the generated client rather than at runtime. */
  method: "negative_keyword" | "llm" | "keyword_boundary" | "undecided";
  /** The span that produced the verdict, where there is one. */
  evidence?: string;
}

export interface IngestSummary {
  considered: number;
  inserted: number;
  updated: number;
  duplicates: number;
  rejected: number;
  undecided: number;
  rejectedReasons: Record<string, number>;
}

export class IngestionEngine {
  constructor(private readonly prisma: PrismaClient) {}

  /* ---------------------------------------------------------------- dedupe */

  /**
   * IDENTITY, not content.
   *
   * The spec hashes `platform:platformId:content`, which makes an EDITED post a
   * different record: the author fixes a typo, the hash changes, and the same
   * thread appears twice in the dashboard. Worse for Google AI Overviews, whose
   * text is regenerated on every query — every run would insert a new row.
   *
   * Identity is platform + platformId. Content gets its own hash so an edit is
   * detectable as an UPDATE, which is the thing you actually want to know.
   */
  static identityHash(mention: CanonicalMention): string {
    return crypto
      .createHash("sha256")
      .update(`${mention.platform}:${mention.platformId}`)
      .digest("hex");
  }

  static contentHash(mention: CanonicalMention): string {
    return crypto
      .createHash("sha256")
      .update(mention.content.replace(/\s+/g, " ").trim().toLowerCase())
      .digest("hex");
  }

  /* ------------------------------------------------------------- relevance */

  /**
   * Three escalating tiers. The expensive one is only reached when needed.
   *
   *   1. negative keywords   free, decisive, no network call
   *   2. local LLM           cheap, self-hosted, handles homonyms
   *   3. word-boundary match fallback when no LLM endpoint is configured
   *
   * WHERE THIS DIFFERS FROM THE SPEC, AND WHY IT MATTERS
   *
   * The spec's catch block returns `{ isRelevant: true, score: 0.5 }` when the
   * LLM is unreachable — it FAILS OPEN. Every mention is admitted at half
   * confidence with no record that the filter never ran, so an Ollama container
   * that dies at 2am silently fills the database with homonym noise that looks
   * exactly like classified data.
   *
   * Here an LLM failure falls through to the deterministic keyword tier and the
   * verdict records that it did. Coverage stays the same; the provenance does
   * not quietly become fiction.
   */
  async evaluateRelevance(
    mention: CanonicalMention,
    product: TrackedProduct
  ): Promise<RelevanceVerdict> {
    const text = mention.content;

    /* Tier 1 — negative keywords. */
    for (const negative of product.excludeKeywords ?? []) {
      if (containsKeyword(text, negative)) {
        return {
          isRelevant: false,
          score: 0,
          method: "negative_keyword",
          evidence: negative,
        };
      }
    }

    /* Tier 2 — local LLM, only if configured. */
    const endpoint = process.env.LOCAL_LLM_ENDPOINT;
    if (endpoint) {
      const verdict = await this.askLocalModel(endpoint, mention, product);
      if (verdict) return verdict;
      // Fell through deliberately: see the method comment.
    }

    /* Tier 3 — word-boundary keyword presence.
     *
     * BOUNDARY, not substring. The spec uses `textLower.includes(kw)`, which
     * admits "GitBookies" for "GitBook" and, more painfully, admits any brand
     * whose name is a substring of an unrelated word. */
    const keywords = [product.name, ...(product.keywords ?? [])];
    const hit = keywords.find((kw) => kw && containsKeyword(text, kw));
    return {
      isRelevant: Boolean(hit),
      score: hit ? 1 : 0,
      method: "keyword_boundary",
      evidence: hit,
    };
  }

  private async askLocalModel(
    endpoint: string,
    mention: CanonicalMention,
    product: TrackedProduct
  ): Promise<RelevanceVerdict | null> {
    const model = process.env.LOCAL_LLM_MODEL ?? "llama3:8b";
    try {
      const response = await fetchWithTimeout(
        `${endpoint.replace(/\/+$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          timeoutMs: 15_000,
          body: JSON.stringify({
            model,
            temperature: 0.1,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content:
                  "You are an entity-recognition assistant. Decide whether the text discusses " +
                  `the specific product "${product.name}", as opposed to a generic use of the ` +
                  'same word. Reply ONLY with JSON: {"isRelevant": boolean, "confidence": number, ' +
                  '"evidence": string}. "evidence" must be a short verbatim span copied from the ' +
                  "text. If the text does not mention the product at all, isRelevant is false.",
              },
              {
                role: "user",
                content:
                  `Known aliases: ${[product.name, ...(product.keywords ?? [])].join(", ")}\n\n` +
                  `Text:\n${mention.content.slice(0, 4000)}`,
              },
            ],
          }),
        }
      );

      if (!response.ok) return null;

      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const raw = body.choices?.[0]?.message?.content;
      if (!raw) return null;

      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()) as {
        isRelevant?: boolean;
        confidence?: number;
        evidence?: string;
      };
      if (typeof parsed.isRelevant !== "boolean") return null;

      /* THE MODEL'S EVIDENCE MUST BE IN THE TEXT.
       *
       * A quote that does not appear in the source is a hallucination, and a
       * hallucinated justification invalidates the verdict it justifies. When
       * the span does not check out, the verdict is discarded and the
       * deterministic tier decides instead. */
      const evidence = parsed.evidence?.trim();
      if (evidence && evidence.length > 8) {
        const normalize = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
        if (!normalize(mention.content).includes(normalize(evidence))) return null;
      }

      return {
        isRelevant: parsed.isRelevant,
        score:
          typeof parsed.confidence === "number"
            ? Math.max(0, Math.min(1, parsed.confidence))
            : 0.5,
        method: "llm",
        evidence,
      };
    } catch {
      // Unreachable, timed out, or unparseable. Fall through to Tier 3.
      return null;
    }
  }

  /* --------------------------------------------------------------- persist */

  /**
   * Persist a batch.
   *
   * Reads existing hashes in ONE query rather than per mention. The spec calls
   * `findUnique` inside the loop, which for a 300-mention batch is 300 round
   * trips — on a serverless function with a connection-pooled Postgres that is
   * both the slowest part of the run and the most likely thing to exhaust the
   * pool.
   */
  async processBatch(
    mentions: CanonicalMention[],
    product: TrackedProduct
  ): Promise<IngestSummary> {
    const summary: IngestSummary = {
      considered: mentions.length,
      inserted: 0,
      updated: 0,
      duplicates: 0,
      rejected: 0,
      undecided: 0,
      rejectedReasons: {},
    };
    if (!mentions.length) return summary;

    // Collapse duplicates WITHIN the batch first: two adapters routinely return
    // the same URL, and inserting then updating it is a wasted write.
    const byIdentity = new Map<string, CanonicalMention>();
    for (const mention of mentions) {
      const id = IngestionEngine.identityHash(mention);
      if (!byIdentity.has(id)) byIdentity.set(id, mention);
      else summary.duplicates++;
    }

    const identities = [...byIdentity.keys()];
    const existing = await this.prisma.mention.findMany({
      where: { identityHash: { in: identities } },
      select: { id: true, identityHash: true, contentHash: true },
    });
    const existingByIdentity = new Map(existing.map((e) => [e.identityHash, e]));

    for (const [identityHash, mention] of byIdentity) {
      const contentHash = IngestionEngine.contentHash(mention);
      const prior = existingByIdentity.get(identityHash);

      if (prior) {
        if (prior.contentHash === contentHash) {
          summary.duplicates++;
          continue;
        }
        // The post was edited. Update in place and keep the original row so the
        // mention's history is one record, not two.
        await this.prisma.mention.update({
          where: { id: prior.id },
          data: {
            content: mention.content,
            contentHash,
            editedAt: new Date(),
            metadata: (mention.metadata ?? {}) as object,
          },
        });
        summary.updated++;
        continue;
      }

      const verdict = await this.evaluateRelevance(mention, product);
      if (!verdict.isRelevant) {
        summary.rejected++;
        const key = verdict.evidence
          ? `${verdict.method}: ${verdict.evidence}`
          : verdict.method;
        summary.rejectedReasons[key] = (summary.rejectedReasons[key] ?? 0) + 1;
        continue;
      }
      if (verdict.method === "undecided") summary.undecided++;

      await this.prisma.mention.create({
        data: {
          productId: product.id,
          platform: mention.platform,
          platformId: mention.platformId,
          identityHash,
          contentHash,
          url: mention.url,
          author: mention.author ?? null,
          authorUrl: mention.authorUrl ?? null,
          content: mention.content,
          publishedAt: mention.publishedAt,
          dateConfidence: mention.dateConfidence,
          discoveredAt: mention.discoveredAt,
          relevanceScore: verdict.score,
          relevanceMethod: verdict.method,
          relevanceEvidence: verdict.evidence ?? null,
          isRelevant: true,
          metadata: (mention.metadata ?? {}) as object,
        },
      });
      summary.inserted++;
    }

    return summary;
  }

  /**
   * Fold adapter results into one batch, preserving coverage gaps.
   *
   * Gaps travel with the data. A caller that only receives `mentions` cannot
   * tell a quiet week from three blocked adapters, and will report the former.
   */
  static flatten(results: PromiseSettledResult<ScrapeResult>[]): {
    mentions: CanonicalMention[];
    gaps: Array<{ platform: string; reason: string; blocked?: boolean }>;
    queriedPlatforms: string[];
  } {
    const mentions: CanonicalMention[] = [];
    const gaps: Array<{ platform: string; reason: string; blocked?: boolean }> = [];
    const queriedPlatforms: string[] = [];

    for (const settled of results) {
      if (settled.status === "rejected") {
        gaps.push({
          platform: "unknown",
          reason: `adapter threw: ${String(
            settled.reason instanceof Error ? settled.reason.message : settled.reason
          )}`,
        });
        continue;
      }
      const result = settled.value;
      mentions.push(...result.mentions);
      if (result.queried) queriedPlatforms.push(result.platform);
      for (const gap of result.gaps) {
        gaps.push({ platform: result.platform, reason: gap.reason, blocked: gap.blocked });
      }
    }

    return { mentions, gaps, queriedPlatforms };
  }
}
