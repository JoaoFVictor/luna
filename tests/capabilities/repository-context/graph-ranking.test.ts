import { describe, expect, it } from "vitest";
import type { Candidate } from "../../../src/capabilities/repository-context/file-analysis.js";
import {
  buildGraphTopology,
  graphRankingMatches,
  graphRankingMatchesDetailed,
  type GraphTopology
} from "../../../src/capabilities/repository-context/graph-ranking.js";
import { projectImportResolutionFrom } from
  "../../../src/capabilities/repository-context/import-resolution.js";

function candidate(filePath: string, imports: readonly string[] = []): Candidate {
  return {
    path: filePath,
    absolutePath: `/repo/${filePath}`,
    content: "",
    truncated: false,
    language: "TypeScript",
    kind: "source",
    symbols: [],
    imports,
    symbol_graph: {
      engine: "heuristic",
      document: {
        relative_path: filePath,
        language: "TypeScript",
        position_encoding: "UTF16CodeUnitOffsetFromLineStart",
        occurrences: [],
        symbols: []
      },
      warnings: []
    }
  };
}

describe("repository context graph ranking", () => {
  it("reuses one bounded topology per candidate corpus across task queries", () => {
    const candidates = [
      candidate("src/entry.ts", ["./service"]),
      candidate("src/service.ts", ["./repository"]),
      candidate("src/repository.ts")
    ];
    const importResolution = projectImportResolutionFrom(candidates);
    const topology = buildGraphTopology(candidates, importResolution);
    const rank = (seedPaths: readonly string[]) => graphRankingMatches({
      candidates,
      seedPaths,
      resolutionSignature: importResolution.signature,
      topology,
      baseScores: { import_dependency: 75, reverse_reference: 72 },
      maxDepth: 3,
      decay: 0.55
    });

    const first = rank(["src/entry.ts"]);
    const second = rank(["src/entry.ts"]);
    rank(["src/repository.ts"]);

    expect(second).toEqual(first);
    expect(first.map((match) => match.path)).toEqual([
      "src/service.ts",
      "src/repository.ts"
    ]);
    expect(topology.estimated_retained_bytes).toBeGreaterThan(0);
  });

  it("bounds high-fanout query traversal before downstream score materialization", () => {
    const seed = candidate("src/seed.ts");
    const neighbors = Array.from({ length: 25_000 }, (_, index) =>
      candidate(`src/node-${index}.ts`)
    );
    const candidates = [seed, ...neighbors];
    const topology: GraphTopology = {
      candidateByPath: new Map(candidates.map((item) => [item.path, item])),
      neighborsByPath: new Map([
        [seed.path, neighbors.map((item) => ({
          path: item.path,
          matchKind: "import" as const,
          matchValue: item.path,
          reason: "synthetic high fanout",
          relation: "import_dependency" as const
        }))]
      ]),
      resolutionSignature: "stress",
      estimated_retained_bytes: 0
    };

    const result = graphRankingMatchesDetailed({
      candidates,
      seedPaths: [seed.path],
      resolutionSignature: "stress",
      topology,
      baseScores: { import_dependency: 75, reverse_reference: 72 },
      maxDepth: 3,
      decay: 0.55
    });

    expect(result.matches).toHaveLength(5_000);
    expect(result.diagnostics).toMatchObject({
      edges_visited: 20_000,
      edges_omitted: 5_000,
      edges_omitted_lower_bound: true,
      matches_omitted: 15_000
    });
    expect(result.diagnostics.frontier_omitted).toBeGreaterThan(0);
  });

  it("shares the edge budget fairly across seeds and reports auditable lower-bound omissions", () => {
    const noisySeed = candidate("src/noisy-seed.ts");
    const quietSeed = candidate("src/quiet-seed.ts");
    const noisyNeighbors = Array.from({ length: 25_000 }, (_, index) =>
      candidate(`src/noisy-${index}.ts`)
    );
    const quietNeighbors = [candidate("src/quiet-a.ts"), candidate("src/quiet-b.ts")];
    const candidates = [noisySeed, quietSeed, ...noisyNeighbors, ...quietNeighbors];
    const relation = (item: Candidate) => ({
      path: item.path,
      matchKind: "import" as const,
      matchValue: item.path,
      reason: "synthetic fairness edge",
      relation: "import_dependency" as const
    });
    const topology: GraphTopology = {
      candidateByPath: new Map(candidates.map((item) => [item.path, item])),
      neighborsByPath: new Map([
        [noisySeed.path, noisyNeighbors.map(relation)],
        [quietSeed.path, quietNeighbors.map(relation)]
      ]),
      resolutionSignature: "fairness",
      estimated_retained_bytes: 0
    };
    const rank = () => graphRankingMatchesDetailed({
      candidates,
      seedPaths: [noisySeed.path, quietSeed.path],
      resolutionSignature: "fairness",
      topology,
      baseScores: { import_dependency: 75, reverse_reference: 72 },
      maxDepth: 1,
      decay: 0.55
    });

    const first = rank();
    const second = rank();

    expect(second).toEqual(first);
    expect(first.matches.slice(0, 4).map((match) => match.path)).toEqual([
      "src/noisy-0.ts",
      "src/quiet-a.ts",
      "src/noisy-1.ts",
      "src/quiet-b.ts"
    ]);
    expect(first.diagnostics).toEqual({
      edges_visited: 20_000,
      edges_omitted: 5_002,
      edges_omitted_lower_bound: true,
      matches_omitted: 15_000,
      frontier_omitted: 15_002
    });
  });

  it("finishes each fairly interleaved depth before expanding the next depth", () => {
    const paths = ["a", "b", "a1", "a2", "b1", "b2", "a1d", "a2d", "b1d", "b2d"]
      .map((name) => candidate(`${name}.ts`));
    const byPath = new Map(paths.map((item) => [item.path, item]));
    const neighbor = (filePath: string) => ({
      path: filePath,
      matchKind: "import" as const,
      matchValue: filePath,
      reason: "synthetic depth edge",
      relation: "import_dependency" as const
    });
    const topology: GraphTopology = {
      candidateByPath: byPath,
      neighborsByPath: new Map([
        ["a.ts", [neighbor("a1.ts"), neighbor("a2.ts")]],
        ["b.ts", [neighbor("b1.ts"), neighbor("b2.ts")]],
        ["a1.ts", [neighbor("a1d.ts")]],
        ["a2.ts", [neighbor("a2d.ts")]],
        ["b1.ts", [neighbor("b1d.ts")]],
        ["b2.ts", [neighbor("b2d.ts")]]
      ]),
      resolutionSignature: "depth-fairness",
      estimated_retained_bytes: 0
    };

    const result = graphRankingMatchesDetailed({
      candidates: paths,
      seedPaths: ["a.ts", "b.ts"],
      resolutionSignature: "depth-fairness",
      topology,
      baseScores: { import_dependency: 75, reverse_reference: 72 },
      maxDepth: 2,
      decay: 0.55
    });

    expect(result.matches.map((match) => [match.path, match.depth, match.seedRank])).toEqual([
      ["a1.ts", 1, 0],
      ["b1.ts", 1, 1],
      ["a2.ts", 1, 0],
      ["b2.ts", 1, 1],
      ["a1d.ts", 2, 0],
      ["b1d.ts", 2, 1],
      ["a2d.ts", 2, 0],
      ["b2d.ts", 2, 1]
    ]);
    expect(result.diagnostics).toEqual({
      edges_visited: 8,
      edges_omitted: 0,
      edges_omitted_lower_bound: false,
      matches_omitted: 0,
      frontier_omitted: 0
    });
  });
});
