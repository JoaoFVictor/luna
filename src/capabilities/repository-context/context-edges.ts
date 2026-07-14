import { Buffer } from "node:buffer";
import {
  basenameStem,
  type Candidate,
  dirnameOf,
  extractSymbols,
  importEdgeType,
  isTestPath,
  unique
} from "./file-analysis.js";
import type { GraphTopology } from "./graph-ranking.js";
import {
  reverseReferenceDefinitionSymbolsFromGraph,
  reverseReferenceSymbolsFromGraph
} from "./symbol-analysis/index.js";
import { lexicalTermsFrom } from "./lexical-ranking.js";
import type { RelatedContextEdge, RelatedContextFile } from "./contracts.js";
import { REPOSITORY_CONTEXT_OUTPUT_LIMITS } from "./config-policy.js";

export type ContextEdgesResult = {
  readonly edges: readonly RelatedContextEdge[];
  readonly omittedEdgesCount: number;
  readonly truncatedEdgeTextCount: number;
};

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export function edgesFrom(input: {
  readonly files: readonly RelatedContextFile[];
  readonly candidates: readonly Candidate[];
  readonly seedFiles: readonly {
    readonly path: string;
    readonly excerpt?: { readonly content: string } | null;
  }[];
  readonly graphTopology: GraphTopology;
}): ContextEdgesResult {
  const edges: RelatedContextEdge[] = [];
  const edgeKeys = new Set<string>();
  let truncatedEdgeTextCount = 0;
  const candidateByPath = new Map(input.candidates.map((candidate) => [candidate.path, candidate]));
  const seedPaths = new Set(input.seedFiles.map((file) => file.path));
  const seedStems = new Set(input.seedFiles.map((file) => basenameStem(file.path)));
  const relatedPaths = new Set(input.files.map((file) => file.path));

  function addEdge(edge: RelatedContextEdge): void {
    const key = `${edge.from}\0${edge.to}\0${edge.type}`;
    if (edgeKeys.has(key)) {
      return;
    }
    edgeKeys.add(key);
    const reason = truncateUtf8(edge.reason, REPOSITORY_CONTEXT_OUTPUT_LIMITS.edge_text_bytes);
    if (reason !== edge.reason) {
      truncatedEdgeTextCount += 1;
    }
    edges.push({ ...edge, reason });
  }

  function seedMatchesContextFile(seed: (typeof input.seedFiles)[number], file: RelatedContextFile): boolean {
    const seedTerms = new Set(unique([
      ...lexicalTermsFrom(seed.path),
      ...lexicalTermsFrom(basenameStem(seed.path)),
      ...(seed.excerpt?.content === undefined
        ? []
        : extractSymbols(seed.excerpt.content, seed.path).flatMap(lexicalTermsFrom))
    ]));
    const contextTerms = new Set([
      ...file.matched_terms.flatMap(lexicalTermsFrom),
      ...file.matched_symbols.flatMap(lexicalTermsFrom),
      ...lexicalTermsFrom(file.excerpt?.content ?? "")
    ]);
    return [...seedTerms].some((term) => contextTerms.has(term));
  }

  for (const candidate of input.candidates.filter((entry) => relatedPaths.has(entry.path))) {
    for (const neighbor of input.graphTopology.neighborsByPath.get(candidate.path) ?? []) {
      if (neighbor.matchKind !== "import" || !relatedPaths.has(neighbor.path)) {
        continue;
      }
      const forward = neighbor.relation === "import_dependency";
      addEdge({
        from: forward ? candidate.path : neighbor.path,
        to: forward ? neighbor.path : candidate.path,
        type: importEdgeType(neighbor.matchValue),
        reason: `Selected file imports/includes ${neighbor.matchValue}.`
      });
    }
  }

  const selectedDefinitionOwners = new Map<string, string[]>();
  for (const candidate of input.candidates.filter((entry) => relatedPaths.has(entry.path))) {
    for (const symbol of reverseReferenceDefinitionSymbolsFromGraph(candidate.symbol_graph)) {
      const owners = selectedDefinitionOwners.get(symbol) ?? [];
      owners.push(candidate.path);
      selectedDefinitionOwners.set(symbol, owners);
    }
  }
  for (const candidate of input.candidates.filter((entry) => relatedPaths.has(entry.path))) {
    for (const symbol of reverseReferenceSymbolsFromGraph(candidate.symbol_graph)) {
      for (const ownerPath of selectedDefinitionOwners.get(symbol) ?? []) {
        if (ownerPath !== candidate.path) {
          addEdge({
            from: candidate.path,
            to: ownerPath,
            type: "references",
            reason: `Selected file references symbol ${symbol}.`
          });
        }
      }
    }
  }

  for (const file of input.files) {
    if (seedPaths.has(file.path)) {
      continue;
    }

    const candidate = candidateByPath.get(file.path);
    if (candidate === undefined) {
      continue;
    }

    if (file.relation === "same_directory") {
      const sameDirSeed = input.seedFiles
        .find((seed) => dirnameOf(seed.path) === dirnameOf(file.path));
      if (sameDirSeed !== undefined) {
        addEdge({
          from: sameDirSeed.path,
          to: file.path,
          type: "nearby",
          reason: "Files share the same directory."
        });
      }
    }

    if (isTestPath(file.path)) {
      const matchedStem = [...seedStems]
        .find((stem) => file.path.toLowerCase().includes(stem.toLowerCase()));
      const testedFile = input.seedFiles
        .find((seed) => basenameStem(seed.path) === matchedStem);
      if (testedFile !== undefined) {
        addEdge({
          from: file.path,
          to: testedFile.path,
          type: "tests",
          reason: "Test/spec path matches changed file name."
        });
      }
    }

    if (file.relation === "config") {
      for (const seed of input.seedFiles) {
        if (!seedMatchesContextFile(seed, file)) {
          continue;
        }
        addEdge({
          from: file.path,
          to: seed.path,
          type: "configured_by",
          reason: "Config file matches seeded concepts."
        });
      }
    }

    if (file.relation === "docs") {
      for (const seed of input.seedFiles) {
        if (!seedMatchesContextFile(seed, file)) {
          continue;
        }
        addEdge({
          from: file.path,
          to: seed.path,
          type: "documents",
          reason: "Documentation mentions changed concepts."
        });
      }
    }

    if (file.relation === "similar_abstraction") {
      const similarSeed = input.seedFiles
        .find((seed) => basenameStem(seed.path) === basenameStem(file.path));
      if (similarSeed !== undefined) {
        addEdge({
          from: file.path,
          to: similarSeed.path,
          type: "similar_to",
          reason: "Files share the same abstraction name."
        });
      }
    }

  }

  const priority: Readonly<Record<RelatedContextEdge["type"], number>> = {
    imports: 0,
    includes: 0,
    requires: 0,
    references: 1,
    tests: 2,
    configured_by: 3,
    documents: 4,
    nearby: 5,
    similar_to: 6
  };
  const rankedEdges = edges.sort((left, right) =>
    priority[left.type] - priority[right.type] ||
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to) ||
    left.type.localeCompare(right.type)
  );
  return {
    edges: rankedEdges.slice(0, REPOSITORY_CONTEXT_OUTPUT_LIMITS.edges),
    omittedEdgesCount: Math.max(0, rankedEdges.length - REPOSITORY_CONTEXT_OUTPUT_LIMITS.edges),
    truncatedEdgeTextCount
  };
}
