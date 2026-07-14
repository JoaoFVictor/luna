import { describe, expect, it } from "vitest";
import type { Candidate } from "../../../src/capabilities/repository-context/file-analysis.js";
import {
  lexicalCandidateScores,
  lexicalCandidateScoresDetailed,
  lexicalTermsFrom,
  type LexicalCorpus
} from "../../../src/capabilities/repository-context/lexical-ranking.js";
import { buildLexicalCorpus } from
  "../../../src/capabilities/repository-context/lexical-corpus.js";

function candidate(input: {
  readonly path: string;
  readonly content?: string;
  readonly symbols?: readonly string[];
}): Candidate {
  return {
    path: input.path,
    absolutePath: `/repo/${input.path}`,
    content: input.content ?? "",
    truncated: false,
    language: "TypeScript",
    kind: "source",
    symbols: input.symbols ?? [],
    imports: [],
    symbol_graph: {
      engine: "heuristic",
      document: {
        relative_path: input.path,
        language: "TypeScript",
        position_encoding: "UTF16CodeUnitOffsetFromLineStart",
        occurrences: [],
        symbols: []
      },
      warnings: []
    }
  };
}

describe("repository context lexical ranking", () => {
  it("normalizes Unicode and camel, snake, and kebab identifiers with conservative morphology", () => {
    expect(lexicalTermsFrom("Notificações FeatureSlug liked_posts feed-item")).toEqual(expect.arrayContaining([
      "notificacoes",
      "feature",
      "slug",
      "liked",
      "like",
      "posts",
      "post",
      "feed",
      "item"
    ]));
  });

  it("keeps issue keys compound instead of leaking their project prefix as a brand term", () => {
    const terms = lexicalTermsFrom("SWING-44 remove arrows");

    expect(terms).toContain("swing44");
    expect(terms).not.toContain("swing");
  });

  it("uses field-weighted IDF so multi-term path and symbol evidence beats repeated prose", () => {
    const candidates = [
      candidate({
        path: "src/services/featureService.ts",
        symbols: ["FeatureService"]
      }),
      candidate({
        path: "docs/noise.ts",
        content: "feature ".repeat(200)
      }),
      candidate({
        path: "src/other.ts",
        content: "service helpers"
      })
    ];
    const scores = lexicalCandidateScores(candidates, ["feature service"], buildLexicalCorpus(candidates));

    expect(scores.get("src/services/featureService.ts")?.score)
      .toBeGreaterThan(scores.get("docs/noise.ts")?.score ?? 0);
    expect(scores.get("src/services/featureService.ts")?.matchedTerms)
      .toEqual(expect.arrayContaining(["feature", "service"]));
  });

  it("matches a single-character typo only for non-trivial query tokens", () => {
    const candidates = [candidate({ path: "src/NotificationService.ts" })];
    const corpus = buildLexicalCorpus(candidates);
    const scores = lexicalCandidateScores(candidates, ["notificaton"], corpus);

    expect(scores.has("src/NotificationService.ts")).toBe(true);
    expect(lexicalCandidateScores(candidates, ["if"], corpus).has("src/NotificationService.ts"))
      .toBe(false);
  });

  it("does not retain an unbounded result cache across distinct task queries", () => {
    const candidates = [candidate({ path: "src/FeatureService.ts" })];
    const corpus = buildLexicalCorpus(candidates);
    const first = lexicalCandidateScores(candidates, ["feature service"], corpus);
    const second = lexicalCandidateScores(candidates, ["feature service"], corpus);

    expect(first).not.toBe(second);
    expect(second).toEqual(first);
    expect(corpus.estimated_retained_bytes).toBeGreaterThan(0);
    for (let index = 0; index < 250; index += 1) {
      lexicalCandidateScores(candidates, [`feature task${index}`], corpus);
    }
    expect(lexicalCandidateScores(candidates, ["feature"], corpus).has("src/FeatureService.ts"))
      .toBe(true);
  });

  it("bounds fuzzy candidates through the build-time trigram index on a large vocabulary", () => {
    const candidates = [candidate({
      path: "src/large-vocabulary.ts",
      content: Array.from({ length: 5_000 }, (_, index) => `notification${index}`).join(" ")
    })];
    const corpus = buildLexicalCorpus(candidates);

    const first = lexicalCandidateScoresDetailed(candidates, ["notificatiox4999"], corpus);
    const second = lexicalCandidateScoresDetailed(candidates, ["notificatiox4999"], corpus);

    expect(second).toEqual(first);
    expect(first.diagnostics.fuzzy_candidates_considered).toBeLessThanOrEqual(512);
    expect(first.diagnostics.fuzzy_candidates_omitted).toBeGreaterThan(0);
    expect(lexicalCandidateScores(candidates, ["notification4999"], corpus)
      .has("src/large-vocabulary.ts")).toBe(true);
  });

  it("bounds query-specific materialization for a 200k-document common posting", () => {
    const shared = candidate({ path: "src/shared.ts", content: "common" });
    const candidates = Array.from({ length: 200_000 }, (_, index) => ({
      ...shared,
      path: `src/file-${index}.ts`,
      absolutePath: `/repo/src/file-${index}.ts`
    }));
    const lengths = Array<number>(candidates.length).fill(1);
    const corpus: LexicalCorpus = {
      candidates,
      postings: new Map([["common", candidates.map((_, document) => ({
        document,
        path: 0,
        symbols: 0,
        content: 1
      }))]]),
      vocabulary: ["common"],
      fuzzyBuckets: new Map(),
      lengths: { path: lengths, symbols: lengths, content: lengths },
      average: { path: 1, symbols: 1, content: 1 },
      estimated_retained_bytes: 0
    };

    const result = lexicalCandidateScoresDetailed(candidates, ["common"], corpus);

    expect(result.scores.size).toBe(4_096);
    expect(result.diagnostics.posting_documents_considered).toBe(8_192);
    expect(result.diagnostics.posting_documents_omitted).toBe(191_808);
    expect(result.diagnostics.query_documents_omitted).toBe(4_096);
  });
});
