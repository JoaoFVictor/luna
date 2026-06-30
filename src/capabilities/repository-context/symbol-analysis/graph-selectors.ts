import path from "node:path";
import {
  isMeaningfulSymbolWord,
  meaningfulSymbolTerms,
  normalizePath,
  unique,
  wordsFrom
} from "./terms.js";
import type {
  FileSymbolGraph,
  SymbolInformation,
  SymbolKind,
  SymbolOccurrence
} from "./types.js";

const REVERSE_REFERENCE_DEFINITION_KINDS = new Set<SymbolKind>([
  "class",
  "component",
  "const",
  "enum",
  "function",
  "interface",
  "method",
  "store",
  "trait",
  "type"
]);
const PRIMARY_DEFINITION_KIND_PRIORITY: ReadonlyMap<SymbolKind, number> = new Map([
  ["component", 100],
  ["store", 95],
  ["class", 90],
  ["function", 80],
  ["const", 75],
  ["interface", 60],
  ["type", 55],
  ["enum", 50],
  ["trait", 50],
  ["namespace", 30],
  ["variable", 10]
]);

export function symbolNamesFromGraph(graph: FileSymbolGraph): string[] {
  return unique([
    ...graph.document.symbols.flatMap((symbol) => wordsFrom(symbol.display_name)),
    ...graph.document.occurrences.flatMap((occurrence) => wordsFrom(occurrence.display_name))
  ].filter(isMeaningfulSymbolWord)).slice(0, 80);
}

export function importValuesFromGraph(graph: FileSymbolGraph): string[] {
  return unique(graph.document.occurrences.flatMap((occurrence) =>
    occurrence.import_value === undefined || occurrence.import_kind === undefined
      ? []
      : [occurrence.import_kind === "require" || occurrence.import_kind === "include"
          ? `${occurrence.import_kind}:${occurrence.import_value}`
          : occurrence.import_value]
  )).slice(0, 120);
}

export function reverseReferenceDefinitionTermsFromGraph(graph: FileSymbolGraph): string[] {
  return unique(graph.document.symbols.flatMap((symbol) =>
    REVERSE_REFERENCE_DEFINITION_KINDS.has(symbol.local_kind)
      ? meaningfulSymbolTerms(symbol.display_name)
      : []
  ));
}

export function reverseReferenceDefinitionSymbolsFromGraph(graph: FileSymbolGraph): string[] {
  return unique(graph.document.symbols.flatMap((symbol) =>
    REVERSE_REFERENCE_DEFINITION_KINDS.has(symbol.local_kind)
      ? [symbol.symbol]
      : []
  ));
}

export function reverseReferenceDefinitionSymbolTermsFromGraph(graph: FileSymbolGraph): readonly {
  readonly symbol: string;
  readonly terms: readonly string[];
}[] {
  return graph.document.symbols.flatMap((symbol) =>
    REVERSE_REFERENCE_DEFINITION_KINDS.has(symbol.local_kind)
      ? [{
          symbol: symbol.symbol,
          terms: meaningfulSymbolTerms(symbol.display_name)
        }]
      : []
  );
}

export function primaryDefinitionSymbolsFromGraph(graph: FileSymbolGraph): string[] {
  const symbols = graph.document.symbols
    .filter((symbol) => PRIMARY_DEFINITION_KIND_PRIORITY.has(symbol.local_kind))
    .map((symbol, index) => ({
      symbol,
      index,
      score: primaryDefinitionScore(graph.document.relative_path, symbol)
    }))
    .sort((left, right) =>
      right.score - left.score ||
      left.index - right.index ||
      left.symbol.symbol.localeCompare(right.symbol.symbol)
    );
  const matched = symbols.filter((entry) => entry.score >= 1_000);
  const fallback = symbols.filter((entry) => entry.score === symbols[0]?.score);
  return (matched.length > 0 ? matched : fallback)
    .map((entry) => entry.symbol.symbol);
}

export function reverseReferenceTermsFromGraph(graph: FileSymbolGraph): string[] {
  return unique(graph.document.occurrences.flatMap((occurrence) =>
    occurrence.roles.some((role) => role === "reference" || role === "read" || role === "import")
      ? reverseReferenceTermsFromOccurrence(occurrence)
      : []
  ));
}

export function reverseReferenceSymbolsFromGraph(graph: FileSymbolGraph): string[] {
  return unique(graph.document.occurrences.flatMap((occurrence) =>
    occurrence.roles.some((role) => role === "reference" || role === "read" || role === "import")
      ? [occurrence.symbol]
      : []
  ));
}

export function reverseReferenceTermsFromOccurrence(occurrence: SymbolOccurrence): string[] {
  return meaningfulSymbolTerms(occurrence.display_name);
}

function primaryDefinitionScore(filePath: string, symbol: SymbolInformation): number {
  const kindScore = PRIMARY_DEFINITION_KIND_PRIORITY.get(symbol.local_kind) ?? 0;
  return kindScore + (primaryNameVariants(filePath).has(symbol.display_name) ? 1_000 : 0);
}

function primaryNameVariants(filePath: string): ReadonlySet<string> {
  const stem = path.posix.basename(normalizePath(filePath)).replace(/\.[^.]+$/u, "");
  const pascal = stem
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
  const camel = pascal === "" ? "" : `${pascal.slice(0, 1).toLowerCase()}${pascal.slice(1)}`;
  return new Set([stem, pascal, camel].filter((value) => value !== ""));
}
