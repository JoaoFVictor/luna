import path from "node:path";
import {
  mergeImports,
  mergeSymbols,
  normalizePath,
  unique,
  wordsFrom
} from "./common.js";
import type {
  FileSymbolAnalysis,
  ImportFact,
  SymbolFact,
  SymbolKind
} from "./types.js";

export function heuristicSymbolNames(content: string, filePath: string): string[] {
  return unique([
    ...analyzeHeuristically(content, filePath).declarations.flatMap((symbol) => wordsFrom(symbol.name)),
    ...wordsFrom(basenameStem(filePath))
  ]).slice(0, 40);
}

export function analyzeHeuristically(
  content: string,
  filePath: string,
  engine: FileSymbolAnalysis["engine"] = filePath.endsWith(".php") ? "php_heuristic" : "heuristic"
): FileSymbolAnalysis {
  const declarations: SymbolFact[] = [];
  const references: SymbolFact[] = [];
  const imports: ImportFact[] = [];

  collectDeclarations(content, declarations);
  collectImports(content, imports);
  declarations.push(...wordsFrom(basenameStem(filePath)).map((name) => ({
    name,
    kind: "variable" as const
  })));

  for (const importFact of imports) {
    references.push({
      name: importFact.value,
      kind: importFact.kind === "use" ? "class" : "variable",
      line: importFact.line
    });
  }

  return {
    engine,
    declarations: mergeSymbols(declarations, []),
    references: mergeSymbols(references, []),
    imports: mergeImports(imports, []),
    warnings: engine === "php_heuristic"
      ? ["PHP AST parser unavailable; using deterministic heuristic symbol scan."]
      : []
  };
}

function collectDeclarations(content: string, declarations: SymbolFact[]): void {
  const patterns: readonly [RegExp, SymbolKind][] = [
    [/export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, "function"],
    [/export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g, "class"],
    [/export\s+(?:default\s+)?interface\s+([A-Za-z_$][\w$]*)/g, "interface"],
    [/export\s+(?:default\s+)?type\s+([A-Za-z_$][\w$]*)/g, "type"],
    [/export\s+(?:default\s+)?enum\s+([A-Za-z_$][\w$]*)/g, "enum"],
    [/(?:function)\s+([A-Za-z_$][\w$]*)/g, "function"],
    [/(?:class)\s+([A-Za-z_$][\w$]*)/g, "class"],
    [/(?:interface)\s+([A-Za-z_$][\w$]*)/g, "interface"],
    [/(?:trait)\s+([A-Za-z_][\w]*)/g, "trait"],
    [/(?:enum)\s+([A-Za-z_][\w]*)/g, "enum"],
    [/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, "variable"],
    [/defineStore\s*\(\s*["']([^"']+)["']/g, "store"],
    [/namespace\s+([^;{]+)[;{]/g, "namespace"]
  ];

  for (const [pattern, kind] of patterns) {
    for (const match of content.matchAll(pattern)) {
      const name = (match[1] ?? "").trim();
      if (name !== "") {
        declarations.push({ name, kind, line: lineFromIndex(content, match.index ?? 0) });
      }
    }
  }
}

function collectImports(content: string, imports: ImportFact[]): void {
  for (const match of content.matchAll(/import\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g)) {
    imports.push(importFact(content, match, "import"));
  }
  for (const match of content.matchAll(/export\s+[^"']+\s+from\s+["']([^"']+)["']/g)) {
    imports.push(importFact(content, match, "import"));
  }
  for (const match of content.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    imports.push(importFact(content, match, "dynamic_import"));
  }
  for (const match of content.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    imports.push(importFact(content, match, "require"));
  }
  for (const match of content.matchAll(/(require_once|require|include_once|include)\s*(?:\(?\s*)["']([^"']+)["']/g)) {
    imports.push({
      value: (match[2] ?? "").trim(),
      kind: (match[1] ?? "include").includes("require") ? "require" : "include",
      line: lineFromIndex(content, match.index ?? 0)
    });
  }
  for (const match of content.matchAll(/use\s+([^;]+);/g)) {
    imports.push(importFact(content, match, "use"));
  }
}

function importFact(
  content: string,
  match: RegExpMatchArray,
  kind: ImportFact["kind"]
): ImportFact {
  return {
    value: (match[1] ?? "").trim(),
    kind,
    line: lineFromIndex(content, match.index ?? 0)
  };
}

function lineFromIndex(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function basenameStem(filePath: string): string {
  const basename = path.posix.basename(normalizePath(filePath));
  return basename.replace(/\.(test|spec)\.[^.]+$/i, "").replace(/\.[^.]+$/i, "");
}
