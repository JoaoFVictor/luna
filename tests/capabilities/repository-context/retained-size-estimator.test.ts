import { describe, expect, it } from "vitest";
import type { Candidate } from "../../../src/capabilities/repository-context/file-analysis.js";
import { buildLexicalCorpus } from "../../../src/capabilities/repository-context/lexical-corpus.js";
import { RepositoryIndexCapacityError } from
  "../../../src/capabilities/repository-context/repository-index.js";
import { estimateRetainedBytes } from
  "../../../src/capabilities/repository-context/retained-size-estimator.js";
import { analyzeFileSymbolGraph } from
  "../../../src/capabilities/repository-context/symbol-analysis/index.js";

function candidate(content: string): Candidate {
  return {
    path: "src/service.ts",
    absolutePath: "/repository/src/service.ts",
    content,
    truncated: false,
    language: "typescript",
    kind: "source",
    symbol_graph: analyzeFileSymbolGraph(content, "src/service.ts"),
    symbols: ["Service", "run"],
    imports: ["./dependency.js"]
  };
}

describe("conservative retained-size accounting", () => {
  it("counts complete fields and derived containers while deduplicating shared references", () => {
    const source = candidate("export class Service { run() {} }\n");
    const candidateBytes = estimateRetainedBytes(source);
    const withDerived = estimateRetainedBytes({
      candidates: [source],
      derived: new Map([["service", { candidate: source, postings: [1, 2, 3] }]])
    });
    const clonedTwice = estimateRetainedBytes([
      { ...source, symbols: [...source.symbols], imports: [...source.imports] },
      { ...source, symbols: [...source.symbols], imports: [...source.imports] }
    ]);

    expect(candidateBytes).toBeGreaterThan(source.content.length * 2);
    expect(withDerived).toBeGreaterThan(candidateBytes);
    expect(clonedTwice).toBeGreaterThan(candidateBytes);
  });

  it("fails closed while a derived lexical index crosses its retained budget", () => {
    const source = candidate("export class Service { run() { return dependency; } }\n");
    const failure = (() => {
      try {
        buildLexicalCorpus([source], { retainedBytesAlready: 900, maxRetainedBytes: 1_000 });
      } catch (cause) {
        return cause;
      }
      return undefined;
    })();

    expect(failure).toBeInstanceOf(RepositoryIndexCapacityError);
    expect((failure as RepositoryIndexCapacityError).diagnostics).toMatchObject({
      phase: "analysis",
      resource: "retained_index_bytes",
      limit: 1_000
    });
  });
});
