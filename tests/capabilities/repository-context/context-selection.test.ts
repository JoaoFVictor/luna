import { describe, expect, it } from "vitest";
import type { RelatedContextFile } from "../../../src/capabilities/repository-context/contracts.js";
import { selectRelatedFiles } from "../../../src/capabilities/repository-context/context-selection.js";

function file(input: {
  readonly path: string;
  readonly relation: RelatedContextFile["relation"];
  readonly score: number;
  readonly hop?: 1 | 2 | 3;
}): RelatedContextFile {
  return {
    path: input.path,
    relation: input.relation,
    score: input.score,
    score_breakdown: {
      [input.relation]: input.score
    },
    ...(input.hop === undefined ? {} : { graphDepth: input.hop, graphSeedRank: 0 }),
    excerpt: null,
    matched_terms: [],
    matched_symbols: [],
    reasons: []
  };
}

describe("repository context selection", () => {
  it("keeps every direct graph neighbor when no reserved evidence competes for the budget", () => {
    const seed = file({ path: "src/entry.ts", relation: "task_seed", score: 100 });
    const direct = ["src/a.ts", "src/b.ts", "src/c.ts"].map((path) =>
      file({ path, relation: "import_dependency", score: 220, hop: 1 })
    );
    const lexicalNoise = file({
      path: "docs/repeated-query.md",
      relation: "query_match",
      score: 10_000
    });

    const selected = selectRelatedFiles(
      [lexicalNoise, ...direct, seed],
      new Set([seed.path]),
      4
    );

    expect(selected.map((candidate) => candidate.path)).toEqual([
      "src/entry.ts",
      "src/a.ts",
      "src/b.ts",
      "src/c.ts"
    ]);
  });

  it("reserves diverse test, config, docs, and similarity evidence before graph fan-out", () => {
    const seed = file({ path: "src/entry.ts", relation: "task_seed", score: 100 });
    const direct = Array.from({ length: 20 }, (_, index) =>
      file({ path: `src/dependency-${index}.ts`, relation: "import_dependency", score: 500 - index, hop: 1 })
    );
    const test = file({ path: "test/entry.test.ts", relation: "test", score: 80 });
    const config = file({ path: "config/entry.yaml", relation: "config", score: 70 });
    const docs = file({ path: "docs/entry.md", relation: "docs", score: 60 });
    const similar = file({ path: "src/other/entry.ts", relation: "similar_abstraction", score: 50 });

    const selected = selectRelatedFiles(
      [...direct, test, config, docs, similar, seed],
      new Set([seed.path]),
      8
    );

    expect(selected.map((candidate) => candidate.path)).toEqual([
      seed.path,
      test.path,
      config.path,
      docs.path,
      similar.path,
      ...direct.slice(0, 3).map((candidate) => candidate.path)
    ]);
  });

  it("does not reserve decayed second- or third-hop candidates over stronger lexical evidence", () => {
    const seed = file({ path: "src/entry.ts", relation: "task_seed", score: 100 });
    const secondHop = file({
      path: "src/indirect.ts",
      relation: "import_dependency",
      score: 132,
      hop: 2
    });
    const lexical = file({ path: "src/query.ts", relation: "query_match", score: 500 });

    const selected = selectRelatedFiles(
      [lexical, secondHop, seed],
      new Set([seed.path]),
      2
    );

    expect(selected.map((candidate) => candidate.path)).toEqual([
      "src/entry.ts",
      "src/query.ts"
    ]);
  });

  it("bounds selection without materializing excerpts across a large ranked corpus", () => {
    const ranked = Array.from({ length: 5_000 }, (_, index) => file({
      path: `src/module-${index.toString().padStart(4, "0")}.ts`,
      relation: index === 0 ? "task_seed" : "query_match",
      score: 5_000 - index
    }));

    const selected = selectRelatedFiles(ranked, new Set([ranked[0]!.path]), 100);

    expect(selected).toHaveLength(100);
    expect(selected.every((candidate) => candidate.excerpt === null)).toBe(true);
  });
});
