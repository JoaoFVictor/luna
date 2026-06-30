import path from "node:path";

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

export function meaningfulSymbolTerms(name: string): string[] {
  const trimmed = name.trim();
  if (trimmed === "") {
    return [];
  }

  const tail = trimmed.split(/[\\/.:#]+/u).filter(Boolean).at(-1);
  return unique([
    trimmed,
    ...(tail === undefined ? [] : [tail])
  ].filter((term) => isMeaningfulSymbolWord(term)));
}

export function isMeaningfulSymbolWord(value: string): boolean {
  return value.length >= 3 && !NOISY_SYMBOL_WORDS.has(value.toLowerCase());
}
