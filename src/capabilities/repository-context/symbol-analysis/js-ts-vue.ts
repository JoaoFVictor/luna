import { parse as parseVueSfc } from "@vue/compiler-sfc";
import ts from "typescript";
import path from "node:path";
import {
  lineRange,
  symbolGraphFromOccurrences,
  normalizePath,
  occurrence
} from "./common.js";
import type {
  FileSymbolGraph,
  FileSymbolGraphOptions,
  ImportKind,
  SymbolOccurrence,
  SymbolRange,
  SymbolKind
} from "./types.js";

export function analyzeJavaScriptLike(
  content: string,
  filePath: string,
  options: FileSymbolGraphOptions = {}
): FileSymbolGraph {
  if (filePath.endsWith(".vue")) {
    return analyzeVue(content, filePath, options);
  }

  return analyzeScript(content, filePath, filePath.endsWith(".tsx") || filePath.endsWith(".jsx"));
}

function analyzeVue(
  content: string,
  filePath: string,
  options: FileSymbolGraphOptions
): FileSymbolGraph {
  const parsed = parseVueSfc(content, { filename: filePath });
  const warnings = options.truncated === true
    ? []
    : parsed.errors.map((error) =>
        typeof error === "string" ? error : error.message
      );
  const descriptor = parsed.descriptor;
  const blocks = [
    descriptor.script,
    descriptor.scriptSetup
  ].filter((block): block is NonNullable<typeof descriptor.script> => block !== null);
  const componentOccurrence = occurrence({
    filePath,
    name: componentNameFrom(filePath),
    kind: "component",
    roles: ["definition"]
  });
  const occurrences = blocks.flatMap((block) =>
    offsetBlockOccurrences(
      content,
      block.content,
      block.loc?.start.offset,
      analyzeScript(block.content, filePath, block.lang === "tsx" || block.lang === "jsx").document.occurrences
    )
  );
  const templateOccurrences = descriptor.template === null
    ? []
    : offsetBlockOccurrences(
        content,
        descriptor.template.content,
        descriptor.template.loc?.start.offset,
        collectTemplateComponentReferences(descriptor.template.content, filePath)
      );

  return symbolGraphFromOccurrences({
    engine: "vue_sfc_symbol_graph",
    filePath,
    language: "vue",
    occurrences: [
      componentOccurrence,
      ...occurrences,
      ...templateOccurrences
    ],
    warnings
  });
}

function analyzeScript(
  content: string,
  filePath: string,
  jsx: boolean
): FileSymbolGraph {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath, jsx)
  );
  const occurrences: SymbolOccurrence[] = [];

  function visit(node: ts.Node): void {
    collectImport(node, sourceFile, filePath, occurrences);
    collectDeclaration(node, sourceFile, filePath, occurrences);
    collectReference(node, sourceFile, filePath, occurrences);
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return symbolGraphFromOccurrences({
    engine: "typescript_symbol_graph",
    filePath,
    language: filePath.endsWith(".vue")
      ? "vue"
      : filePath.endsWith(".ts") || filePath.endsWith(".tsx")
        ? "typescript"
        : "javascript",
    occurrences
  });
}

function offsetBlockOccurrences(
  fullContent: string,
  blockContent: string,
  hintedOffset: number | undefined,
  occurrences: readonly SymbolOccurrence[]
): SymbolOccurrence[] {
  const blockOffset = blockContentOffset(fullContent, blockContent, hintedOffset);
  const start = lineAndCharacterAt(fullContent, blockOffset);
  return occurrences.map((item) => ({
    ...item,
    ...(item.range === undefined
      ? {}
      : { range: offsetRange(item.range, start) })
  }));
}

function collectTemplateComponentReferences(
  content: string,
  filePath: string
): SymbolOccurrence[] {
  const occurrences: SymbolOccurrence[] = [];
  const pattern = /<\/?\s*([A-Za-z][A-Za-z0-9_.-]*)\b/g;
  for (const match of content.matchAll(pattern)) {
    const rawName = match[1] ?? "";
    const name = componentNameFromTag(rawName);
    if (name === undefined) {
      continue;
    }
    const start = (match.index ?? 0) + match[0].indexOf(rawName);
    occurrences.push(occurrence({
      filePath,
      name,
      kind: "component",
      roles: ["reference", "read"],
      range: lineRange(content, start, start + rawName.length)
    }));
  }
  return occurrences;
}

function componentNameFromTag(name: string): string | undefined {
  if (name.includes(".") || name === "template") {
    return undefined;
  }
  if (/^[A-Z]/u.test(name)) {
    return name;
  }
  if (name.includes("-")) {
    return name
      .split("-")
      .filter(Boolean)
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join("");
  }
  return undefined;
}

function blockContentOffset(
  fullContent: string,
  blockContent: string,
  hintedOffset: number | undefined
): number {
  if (
    hintedOffset !== undefined &&
    hintedOffset >= 0 &&
    fullContent.slice(hintedOffset, hintedOffset + blockContent.length) === blockContent
  ) {
    return hintedOffset;
  }
  const found = fullContent.indexOf(blockContent);
  return found >= 0 ? found : 0;
}

function offsetRange(
  range: SymbolRange,
  start: SymbolRangeStart
): SymbolRange {
  return {
    start_line: range.start_line + start.line,
    start_character: range.start_line === 0
      ? range.start_character + start.character
      : range.start_character,
    end_line: range.end_line + start.line,
    end_character: range.end_line === 0
      ? range.end_character + start.character
      : range.end_character
  };
}

type SymbolRangeStart = {
  readonly line: number;
  readonly character: number;
};

function lineAndCharacterAt(content: string, offset: number): SymbolRangeStart {
  const prefix = content.slice(0, offset);
  return {
    line: prefix.split("\n").length - 1,
    character: offset - Math.max(prefix.lastIndexOf("\n") + 1, 0)
  };
}

function collectImport(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
  occurrences: SymbolOccurrence[]
): void {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    pushImport(node.moduleSpecifier.text, "import", sourceFile, filePath, node.moduleSpecifier, occurrences);
    return;
  }

  if (!ts.isCallExpression(node)) {
    return;
  }

  const firstArg = node.arguments[0];
  if (firstArg === undefined || !ts.isStringLiteralLike(firstArg)) {
    return;
  }

  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    pushImport(firstArg.text, "dynamic_import", sourceFile, filePath, firstArg, occurrences);
  } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
    pushImport(firstArg.text, "require", sourceFile, filePath, firstArg, occurrences);
  }
}

function collectDeclaration(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
  occurrences: SymbolOccurrence[]
): void {
  const kind = declarationKind(node);

  if (hasName(node) && kind !== undefined) {
    occurrences.push(occurrence({
      filePath,
      name: node.name.text,
      kind,
      roles: ["definition"],
      range: rangeOf(sourceFile, node.name)
    }));
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    occurrences.push(occurrence({
      filePath,
      name: node.name.text,
      kind: storeKind(node) ?? variableDeclarationKind(node),
      roles: ["definition", "write"],
      range: rangeOf(sourceFile, node.name)
    }));
  }
}

function collectReference(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
  occurrences: SymbolOccurrence[]
): void {
  if (ts.isCallExpression(node)) {
    collectEntityReference(node.expression, sourceFile, filePath, occurrences);
  } else if (ts.isNewExpression(node)) {
    collectEntityReference(node.expression, sourceFile, filePath, occurrences);
  } else if (ts.isTypeReferenceNode(node)) {
    collectTypeNameReference(node.typeName, sourceFile, filePath, occurrences);
  } else if (ts.isExpressionWithTypeArguments(node)) {
    collectEntityReference(node.expression, sourceFile, filePath, occurrences);
  } else if (ts.isPropertyAccessExpression(node)) {
    collectEntityReference(node, sourceFile, filePath, occurrences);
  } else if (ts.isJsxOpeningLikeElement(node)) {
    collectJsxTagReference(node.tagName, sourceFile, filePath, occurrences);
  }
}

function collectEntityReference(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  filePath: string,
  occurrences: SymbolOccurrence[]
): void {
  if (ts.isIdentifier(node)) {
    pushReference(node.text, "variable", sourceFile, filePath, node, occurrences);
    return;
  }

  if (ts.isPropertyAccessExpression(node)) {
    collectEntityReference(node.expression, sourceFile, filePath, occurrences);
    pushReference(node.name.text, "method", sourceFile, filePath, node.name, occurrences);
  }
}

function collectTypeNameReference(
  node: ts.EntityName,
  sourceFile: ts.SourceFile,
  filePath: string,
  occurrences: SymbolOccurrence[]
): void {
  occurrences.push(occurrence({
    filePath,
    name: node.getText(sourceFile),
    kind: "type",
    roles: ["reference", "read"],
    range: rangeOf(sourceFile, node)
  }));
}

function collectJsxTagReference(
  node: ts.JsxTagNameExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
  occurrences: SymbolOccurrence[]
): void {
  if (ts.isIdentifier(node)) {
    pushReference(node.text, "component", sourceFile, filePath, node, occurrences);
  } else if (ts.isPropertyAccessExpression(node)) {
    collectEntityReference(node, sourceFile, filePath, occurrences);
  }
}

function pushReference(
  name: string,
  kind: SymbolKind,
  sourceFile: ts.SourceFile,
  filePath: string,
  node: ts.Node,
  occurrences: SymbolOccurrence[]
): void {
  occurrences.push(occurrence({
    filePath,
    name,
    kind,
    roles: ["reference", "read"],
    range: rangeOf(sourceFile, node)
  }));
}

function pushImport(
  value: string,
  kind: ImportKind,
  sourceFile: ts.SourceFile,
  filePath: string,
  node: ts.Node,
  occurrences: SymbolOccurrence[]
): void {
  occurrences.push(occurrence({
    filePath,
    name: value,
    kind: "variable",
    roles: ["import", "reference"],
    range: rangeOf(sourceFile, node),
    import_value: value,
    import_kind: kind
  }));
}

function hasName(node: ts.Node): node is ts.Node & { readonly name: ts.Identifier } {
  const name = (node as { readonly name?: ts.Node }).name;
  return name !== undefined && ts.isIdentifier(name);
}

function declarationKind(node: ts.Node): SymbolKind | undefined {
  if (ts.isFunctionDeclaration(node)) {
    return "function";
  }
  if (ts.isClassDeclaration(node)) {
    return "class";
  }
  if (ts.isInterfaceDeclaration(node)) {
    return "interface";
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return "type";
  }
  if (ts.isEnumDeclaration(node)) {
    return "enum";
  }
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
    return "method";
  }
  return undefined;
}

function storeKind(node: ts.VariableDeclaration): SymbolKind | undefined {
  return node.initializer !== undefined &&
    ts.isCallExpression(node.initializer) &&
    ts.isIdentifier(node.initializer.expression) &&
    node.initializer.expression.text === "defineStore"
    ? "store"
    : undefined;
}

function variableDeclarationKind(node: ts.VariableDeclaration): SymbolKind {
  const declarationList = node.parent;
  return ts.isVariableDeclarationList(declarationList) &&
    (declarationList.flags & ts.NodeFlags.Const) !== 0
    ? "const"
    : "variable";
}

function scriptKindFor(filePath: string, jsx: boolean): ts.ScriptKind {
  if (jsx) {
    return filePath.endsWith(".tsx") || filePath.endsWith(".vue")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.JSX;
  }
  if (filePath.endsWith(".ts") || filePath.endsWith(".vue")) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JS;
}

function rangeOf(sourceFile: ts.SourceFile, node: ts.Node): SymbolRange {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    start_line: start.line,
    start_character: start.character,
    end_line: end.line,
    end_character: end.character
  };
}

function componentNameFrom(filePath: string): string {
  const stem = path.posix.basename(normalizePath(filePath)).replace(/\.[^.]+$/u, "");
  return stem
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
}
