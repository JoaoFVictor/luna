import { describe, expect, it } from "vitest";
import type { Candidate } from "../../../src/capabilities/repository-context/file-analysis.js";
import { edgesFrom } from "../../../src/capabilities/repository-context/context-edges.js";
import type { RelatedContextFile } from
  "../../../src/capabilities/repository-context/contracts.js";
import { projectImportResolutionFrom } from
  "../../../src/capabilities/repository-context/import-resolution.js";
import { buildGraphTopology } from
  "../../../src/capabilities/repository-context/graph-ranking.js";
import { REPOSITORY_CONTEXT_OUTPUT_LIMITS } from
  "../../../src/capabilities/repository-context/config-policy.js";

function candidate(filePath: string): Candidate {
  return {
    path: filePath,
    absolutePath: `/repo/${filePath}`,
    content: "common",
    truncated: false,
    kind: "config",
    symbols: [],
    imports: [],
    symbol_graph: {
      engine: "heuristic",
      document: {
        relative_path: filePath,
        position_encoding: "UTF16CodeUnitOffsetFromLineStart",
        occurrences: [],
        symbols: []
      },
      warnings: []
    }
  };
}

function configFile(filePath: string): RelatedContextFile {
  return {
    path: filePath,
    relation: "config",
    score: 24,
    score_breakdown: { config: 24 },
    excerpt: null,
    matched_terms: ["common"],
    matched_symbols: [],
    reasons: ["Repository config matches seeded concepts."]
  };
}

describe("repository context edge output policy", () => {
  it("caps and audits deterministic fan-out across one hundred selected nodes", () => {
    const candidates = Array.from({ length: 100 }, (_, index) =>
      candidate(`config/common-${index.toString().padStart(3, "0")}.yaml`)
    );
    const files = candidates.map((entry) => configFile(entry.path));
    const seedFiles = Array.from({ length: 100 }, (_, index) => ({
      path: `src/common-seed-${index.toString().padStart(3, "0")}.ts`
    }));

    const importResolution = projectImportResolutionFrom(candidates);
    const result = edgesFrom({
      files,
      candidates,
      seedFiles,
      graphTopology: buildGraphTopology(candidates, importResolution)
    });

    expect(result.edges).toHaveLength(REPOSITORY_CONTEXT_OUTPUT_LIMITS.edges);
    expect(result.omittedEdgesCount).toBe(9_000);
    expect(result.edges[0]).toEqual(expect.objectContaining({
      from: "config/common-000.yaml",
      to: "src/common-seed-000.ts",
      type: "configured_by"
    }));
  });
});
