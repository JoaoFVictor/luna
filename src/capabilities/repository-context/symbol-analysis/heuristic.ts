import path from "node:path";
import {
  symbolGraphFromOccurrences,
  lineRange,
  normalizePath,
  occurrence,
  unique,
  wordsFrom
} from "./common.js";
import type {
  FileSymbolGraph,
  ImportKind,
  SymbolOccurrence,
  SymbolKind
} from "./types.js";

export function heuristicSymbolNames(content: string, filePath: string): string[] {
  return unique([
    ...analyzeHeuristically(content, filePath).document.occurrences
      .filter((item) => item.roles.includes("definition"))
      .flatMap((item) => wordsFrom(item.display_name)),
    ...wordsFrom(basenameStem(filePath))
  ]).slice(0, 40);
}

export function analyzeHeuristically(
  content: string,
  filePath: string,
  engine: FileSymbolGraph["engine"] = filePath.endsWith(".php") ? "php_heuristic" : "heuristic"
): FileSymbolGraph {
  const occurrences: SymbolOccurrence[] = [];

  collectDeclarations(content, filePath, occurrences);
  collectImports(content, filePath, occurrences);
  occurrences.push(...wordsFrom(basenameStem(filePath)).map((name) =>
    occurrence({
      filePath,
      name,
      kind: "variable",
      roles: ["definition"]
    })
  ));

  return symbolGraphFromOccurrences({
    engine,
    filePath,
    occurrences,
    warnings: engine === "php_heuristic"
      ? ["PHP symbol graph parser unavailable; using deterministic heuristic symbol scan."]
      : []
  });
}

type HeuristicImport = {
  readonly value: string;
  readonly kind: ImportKind;
  readonly range?: SymbolOccurrence["range"];
};

function collectDeclarations(
  content: string,
  filePath: string,
  occurrences: SymbolOccurrence[]
): void {
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
        occurrences.push(occurrence({
          filePath,
          name,
          kind,
          roles: ["definition"],
          range: lineRange(content, match.index ?? 0, (match.index ?? 0) + match[0].length)
        }));
      }
    }
  }
}

function collectImports(
  content: string,
  filePath: string,
  occurrences: SymbolOccurrence[]
): void {
  const imports: HeuristicImport[] = [];
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
    const index = match.index ?? 0;
    imports.push({
      value: (match[2] ?? "").trim(),
      kind: (match[1] ?? "include").includes("require") ? "require" : "include",
      range: lineRange(content, index, index + match[0].length)
    });
  }
  for (const match of content.matchAll(/use\s+([^;]+);/g)) {
    imports.push(importFact(content, match, "use"));
  }

  for (const importFact of imports) {
    occurrences.push(occurrence({
      filePath,
      name: importFact.value,
      kind: importFact.kind === "use" ? "class" : "variable",
      roles: ["import", "reference"],
      ...(importFact.range === undefined ? {} : { range: importFact.range }),
      import_value: importFact.value,
      import_kind: importFact.kind
    }));
  }
}

function importFact(
  content: string,
  match: RegExpMatchArray,
  kind: ImportKind
): HeuristicImport {
  const index = match.index ?? 0;
  return {
    value: (match[1] ?? "").trim(),
    kind,
    range: lineRange(content, index, index + match[0].length)
  };
}

function basenameStem(filePath: string): string {
  const basename = path.posix.basename(normalizePath(filePath));
  return basename.replace(/\.(test|spec)\.[^.]+$/i, "").replace(/\.[^.]+$/i, "");
}
