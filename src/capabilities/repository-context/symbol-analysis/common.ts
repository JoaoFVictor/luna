import path from "node:path";
import type {
  FileSymbolAnalysis,
  ImportFact,
  SymbolFact
} from "./types.js";

const NOISY_SYMBOL_WORDS = new Set([
  "array",
  "any",
  "async",
  "await",
  "boolean",
  "class",
  "code",
  "const",
  "date",
  "default",
  "error",
  "export",
  "false",
  "from",
  "function",
  "import",
  "interface",
  "key",
  "left",
  "let",
  "link",
  "map",
  "math",
  "max",
  "message",
  "min",
  "null",
  "number",
  "object",
  "promise",
  "readonly",
  "record",
  "ref",
  "return",
  "right",
  "set",
  "string",
  "symbol",
  "true",
  "type",
  "undefined",
  "value",
  "values",
  "var",
  "void"
]);

export function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

export function wordsFrom(value: string): string[] {
  return value
    .split(/[^A-Za-z0-9_]+/)
    .filter((word) => word.length >= 3 && !/^\d+$/.test(word));
}

export function symbolNamesFromAnalysis(analysis: FileSymbolAnalysis): string[] {
  return unique([
    ...analysis.declarations.flatMap((symbol) => wordsFrom(symbol.name)),
    ...analysis.references.flatMap((symbol) => wordsFrom(symbol.name))
  ].filter((word) => !NOISY_SYMBOL_WORDS.has(word.toLowerCase()))).slice(0, 80);
}

export function importValuesFromAnalysis(analysis: FileSymbolAnalysis): string[] {
  return unique(analysis.imports.map((importFact) =>
    importFact.kind === "require" || importFact.kind === "include"
      ? `${importFact.kind}:${importFact.value}`
      : importFact.value
  )).slice(0, 120);
}

export function mergeAnalysis(
  primary: FileSymbolAnalysis,
  fallback: FileSymbolAnalysis
): FileSymbolAnalysis {
  return {
    engine: primary.engine,
    declarations: mergeSymbols(primary.declarations, fallback.declarations),
    references: mergeSymbols(primary.references, fallback.references),
    imports: mergeImports(primary.imports, fallback.imports),
    warnings: unique([...primary.warnings, ...fallback.warnings])
  };
}

export function mergeSymbols(
  left: readonly SymbolFact[],
  right: readonly SymbolFact[]
): SymbolFact[] {
  const symbols = new Map<string, SymbolFact>();
  for (const symbol of [...left, ...right]) {
    const key = `${symbol.kind}\0${symbol.name}`;
    if (!symbols.has(key)) {
      symbols.set(key, symbol);
    }
  }
  return [...symbols.values()].sort(compareSymbol);
}

export function mergeImports(
  left: readonly ImportFact[],
  right: readonly ImportFact[]
): ImportFact[] {
  const imports = new Map<string, ImportFact>();
  for (const importFact of [...left, ...right]) {
    const key = `${importFact.kind}\0${importFact.value}`;
    if (!imports.has(key)) {
      imports.set(key, importFact);
    }
  }
  return [...imports.values()].sort((a, b) =>
    a.value.localeCompare(b.value) || a.kind.localeCompare(b.kind)
  );
}

function compareSymbol(left: SymbolFact, right: SymbolFact): number {
  return left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind);
}
