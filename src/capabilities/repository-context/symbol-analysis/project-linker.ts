import type { Candidate } from "../file-analysis.js";
import {
  reverseReferenceDefinitionSymbolTermsFromGraph,
  reverseReferenceTermsFromOccurrence,
  symbolNamesFromGraph
} from "./common.js";
import type { FileSymbolGraph, SymbolOccurrence } from "./types.js";

export type ImportTargetResolver = (
  importValue: string,
  fromPath: string
) => readonly string[];

export function linkProjectSymbolReferences(
  candidates: readonly Candidate[],
  resolveImportTargets: ImportTargetResolver
): readonly Candidate[] {
  const candidateByPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
  return candidates.map((candidate) => {
    const importedSymbols = importedSymbolMap(candidate, candidateByPath, resolveImportTargets);
    if (importedSymbols.size === 0) {
      return candidate;
    }

    const graph = relinkGraphReferences(candidate.symbol_graph, importedSymbols);
    return graph === candidate.symbol_graph
      ? candidate
      : {
          ...candidate,
          symbol_graph: graph,
          symbols: symbolNamesFromGraph(graph)
        };
  });
}

function importedSymbolMap(
  candidate: Candidate,
  candidateByPath: ReadonlyMap<string, Candidate>,
  resolveImportTargets: ImportTargetResolver
): ReadonlyMap<string, string> {
  const symbols = new Map<string, string>();

  for (const importValue of candidate.imports) {
    for (const target of resolveImportTargets(importValue, candidate.path)) {
      const targetCandidate = candidateByPath.get(target);
      if (targetCandidate === undefined) {
        continue;
      }
      for (const definition of reverseReferenceDefinitionSymbolTermsFromGraph(targetCandidate.symbol_graph)) {
        for (const term of definition.terms) {
          if (!symbols.has(term)) {
            symbols.set(term, definition.symbol);
          }
        }
      }
    }
  }

  return symbols;
}

function relinkGraphReferences(
  graph: FileSymbolGraph,
  importedSymbols: ReadonlyMap<string, string>
): FileSymbolGraph {
  let changed = false;
  const occurrences = graph.document.occurrences.map((occurrence) => {
    const linked = linkedOccurrence(occurrence, importedSymbols);
    changed ||= linked !== occurrence;
    return linked;
  });

  return changed
    ? {
        ...graph,
        document: {
          ...graph.document,
          occurrences
        }
      }
    : graph;
}

function linkedOccurrence(
  occurrence: SymbolOccurrence,
  importedSymbols: ReadonlyMap<string, string>
): SymbolOccurrence {
  if (
    occurrence.roles.includes("definition") ||
    !occurrence.roles.some((role) => role === "reference" || role === "read" || role === "import")
  ) {
    return occurrence;
  }

  for (const term of reverseReferenceTermsFromOccurrence(occurrence)) {
    const symbol = importedSymbols.get(term);
    if (symbol !== undefined && symbol !== occurrence.symbol) {
      return { ...occurrence, symbol };
    }
  }

  return occurrence;
}
