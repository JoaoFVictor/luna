import { SYMBOL_ROLE_BITS } from "./types.js";
import { normalizePath } from "./terms.js";
import type {
  FileSymbolGraph,
  ImportKind,
  SymbolInformation,
  SymbolKind,
  SymbolOccurrence,
  SymbolRange,
  SymbolRole
} from "./types.js";

export function symbolGraphFromOccurrences(input: {
  readonly engine: FileSymbolGraph["engine"];
  readonly filePath: string;
  readonly language?: string;
  readonly occurrences: readonly SymbolOccurrence[];
  readonly warnings?: readonly string[];
}): FileSymbolGraph {
  const occurrences = mergeOccurrences(input.occurrences, []);
  return {
    engine: input.engine,
    document: {
      relative_path: normalizePath(input.filePath),
      ...(input.language === undefined ? {} : { language: input.language }),
      position_encoding: "UTF16CodeUnitOffsetFromLineStart",
      occurrences,
      symbols: mergeSymbolInformation(symbolsFromOccurrences(occurrences))
    },
    warnings: [...(input.warnings ?? [])]
  };
}

export function occurrence(input: {
  readonly filePath: string;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly roles: readonly SymbolRole[];
  readonly range?: SymbolRange;
  readonly import_value?: string;
  readonly import_kind?: ImportKind;
}): SymbolOccurrence {
  const rangeFields = typedRangeFields(input.range);
  return {
    symbol: symbolId(input.filePath, input.name, input.kind),
    symbol_roles: symbolRoleBitset(input.roles),
    display_name: input.name,
    kind: input.kind,
    roles: input.roles,
    ...rangeFields,
    ...(input.range === undefined ? {} : { range: input.range }),
    ...(input.import_value === undefined ? {} : { import_value: input.import_value }),
    ...(input.import_kind === undefined ? {} : { import_kind: input.import_kind })
  };
}

export function lineRange(
  content: string,
  startIndex: number,
  endIndex: number
): SymbolRange {
  const prefix = content.slice(0, startIndex);
  const endPrefix = content.slice(0, endIndex);
  const startLine = prefix.split("\n").length - 1;
  const endLine = endPrefix.split("\n").length - 1;
  const startLineStart = Math.max(prefix.lastIndexOf("\n") + 1, 0);
  const endLineStart = Math.max(endPrefix.lastIndexOf("\n") + 1, 0);
  return {
    start_line: startLine,
    start_character: startIndex - startLineStart,
    end_line: endLine,
    end_character: endIndex - endLineStart
  };
}

function symbolId(filePath: string, name: string, kind: SymbolKind): string {
  const descriptors = [
    `${quotedSymbolName(normalizePath(filePath))}/`,
    `${quotedSymbolName(name)}${symbolSuffix(kind)}`
  ].join("");
  return `luna . . . ${descriptors}`;
}

function symbolRoleBitset(roles: readonly SymbolRole[]): number {
  let bitset = roles.includes("definition") ? SYMBOL_ROLE_BITS.definition : 0;
  if (roles.includes("import")) {
    bitset |= SYMBOL_ROLE_BITS.import;
  }
  if (roles.includes("write")) {
    bitset |= SYMBOL_ROLE_BITS.write;
  }
  if (roles.includes("read") || roles.includes("reference")) {
    bitset |= SYMBOL_ROLE_BITS.read;
  }
  return bitset;
}

function typedRangeFields(range: SymbolRange | undefined): Pick<SymbolOccurrence, "single_line_range" | "multi_line_range"> {
  if (range === undefined) {
    return {};
  }
  if (range.start_line === range.end_line) {
    return {
      single_line_range: {
        line: range.start_line,
        start_character: range.start_character,
        end_character: range.end_character
      }
    };
  }
  return { multi_line_range: range };
}

function quotedSymbolName(value: string): string {
  const simple = /^[A-Za-z0-9_+$-]+$/u;
  if (simple.test(value)) {
    return value;
  }
  return `\`${value.replace(/`/gu, "``")}\``;
}

function symbolSuffix(kind: SymbolKind): string {
  switch (kind) {
    case "class":
    case "component":
    case "enum":
    case "interface":
    case "store":
    case "trait":
    case "type":
      return "#";
    case "namespace":
      return "/";
    case "function":
    case "const":
    case "variable":
      return ".";
    case "method":
      return "().";
  }
}

function mergeOccurrences(
  left: readonly SymbolOccurrence[],
  right: readonly SymbolOccurrence[]
): SymbolOccurrence[] {
  const occurrences = new Map<string, SymbolOccurrence>();
  for (const occurrence of [...left, ...right]) {
    const key = occurrenceKey(occurrence);
    if (!occurrences.has(key)) {
      occurrences.set(key, occurrence);
    }
  }
  return [...occurrences.values()].sort(compareOccurrence);
}

function mergeSymbolInformation(
  values: readonly SymbolInformation[]
): SymbolInformation[] {
  const symbols = new Map<string, SymbolInformation>();
  for (const symbol of values) {
    if (!symbols.has(symbol.symbol)) {
      symbols.set(symbol.symbol, symbol);
    }
  }
  return [...symbols.values()].sort((left, right) =>
    left.symbol.localeCompare(right.symbol)
  );
}

function symbolsFromOccurrences(occurrences: readonly SymbolOccurrence[]): SymbolInformation[] {
  return occurrences
    .filter((item) => item.roles.includes("definition"))
    .map((item) => ({
      symbol: item.symbol,
      display_name: item.display_name,
      kind: symbolKindCode(item.kind),
      local_kind: item.kind
    }));
}

function symbolKindCode(kind: SymbolKind): number {
  switch (kind) {
    case "class":
    case "component":
      return 7;
    case "const":
      return 8;
    case "enum":
      return 11;
    case "function":
      return 17;
    case "interface":
      return 21;
    case "method":
      return 26;
    case "namespace":
      return 30;
    case "store":
    case "variable":
      return 61;
    case "trait":
      return 53;
    case "type":
      return 55;
  }
}

function occurrenceKey(occurrence: SymbolOccurrence): string {
  const range = occurrence.range === undefined
    ? "?:?:?"
    : `${occurrence.range.start_line}:${occurrence.range.start_character}:${occurrence.range.end_line}:${occurrence.range.end_character}`;
  return [
    occurrence.symbol,
    occurrence.roles.join(","),
    range,
    occurrence.import_kind ?? "",
    occurrence.import_value ?? ""
  ].join("\0");
}

function compareOccurrence(left: SymbolOccurrence, right: SymbolOccurrence): number {
  return (left.range?.start_line ?? Number.MAX_SAFE_INTEGER) - (right.range?.start_line ?? Number.MAX_SAFE_INTEGER) ||
    left.display_name.localeCompare(right.display_name) ||
    left.roles.join(",").localeCompare(right.roles.join(","));
}
