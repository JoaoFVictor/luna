import { parse as parseVueSfc } from "@vue/compiler-sfc";
import ts from "typescript";
import path from "node:path";
import {
  mergeAnalysis,
  mergeImports,
  mergeSymbols,
  normalizePath
} from "./common.js";
import { analyzeHeuristically } from "./heuristic.js";
import type {
  FileSymbolAnalysis,
  FileSymbolAnalysisOptions,
  ImportFact,
  SymbolFact,
  SymbolKind
} from "./types.js";

export function analyzeJavaScriptLike(
  content: string,
  filePath: string,
  options: FileSymbolAnalysisOptions = {}
): FileSymbolAnalysis {
  if (filePath.endsWith(".vue")) {
    return analyzeVue(content, filePath, options);
  }

  return mergeAnalysis(
    analyzeScript(content, filePath, filePath.endsWith(".tsx") || filePath.endsWith(".jsx")),
    analyzeHeuristically(content, filePath)
  );
}

function analyzeVue(
  content: string,
  filePath: string,
  options: FileSymbolAnalysisOptions
): FileSymbolAnalysis {
  const fallback = analyzeHeuristically(content, filePath);
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
  const declarations: SymbolFact[] = [{
    name: componentNameFrom(filePath),
    kind: "component"
  }];
  const analyses = blocks.map((block) =>
    analyzeScript(block.content, filePath, block.lang === "tsx" || block.lang === "jsx")
  );

  return mergeAnalysis(
    {
      engine: "vue_sfc_ast",
      declarations: mergeSymbols(declarations, analyses.flatMap((analysis) => analysis.declarations)),
      references: mergeSymbols(analyses.flatMap((analysis) => analysis.references), []),
      imports: mergeImports(analyses.flatMap((analysis) => analysis.imports), []),
      warnings
    },
    fallback
  );
}

function analyzeScript(
  content: string,
  filePath: string,
  jsx: boolean
): FileSymbolAnalysis {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath, jsx)
  );
  const declarations: SymbolFact[] = [];
  const references: SymbolFact[] = [];
  const imports: ImportFact[] = [];

  function visit(node: ts.Node): void {
    collectImport(node, sourceFile, imports);
    collectDeclaration(node, sourceFile, declarations);
    collectReference(node, sourceFile, references);
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return {
    engine: "typescript_ast",
    declarations: mergeSymbols(declarations, []),
    references: mergeSymbols(references, []),
    imports: mergeImports(imports, []),
    warnings: []
  };
}

function collectImport(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  imports: ImportFact[]
): void {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    imports.push({
      value: node.moduleSpecifier.text,
      kind: "import",
      line: lineOf(sourceFile, node)
    });
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
    imports.push({ value: firstArg.text, kind: "dynamic_import", line: lineOf(sourceFile, node) });
  } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
    imports.push({ value: firstArg.text, kind: "require", line: lineOf(sourceFile, node) });
  }
}

function collectDeclaration(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  declarations: SymbolFact[]
): void {
  const line = lineOf(sourceFile, node);
  const kind = declarationKind(node);

  if (hasName(node) && kind !== undefined) {
    declarations.push({
      name: node.name.text,
      kind,
      line
    });
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    declarations.push({
      name: node.name.text,
      kind: storeKind(node) ?? "variable",
      line
    });
  }
}

function collectReference(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  references: SymbolFact[]
): void {
  if (ts.isCallExpression(node)) {
    collectEntityReference(node.expression, sourceFile, references);
  } else if (ts.isNewExpression(node)) {
    collectEntityReference(node.expression, sourceFile, references);
  } else if (ts.isTypeReferenceNode(node)) {
    collectTypeNameReference(node.typeName, sourceFile, references);
  } else if (ts.isExpressionWithTypeArguments(node)) {
    collectEntityReference(node.expression, sourceFile, references);
  } else if (ts.isJsxOpeningLikeElement(node)) {
    collectJsxTagReference(node.tagName, sourceFile, references);
  }
}

function collectEntityReference(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  references: SymbolFact[]
): void {
  if (ts.isIdentifier(node)) {
    pushReference(node.text, "variable", sourceFile, node, references);
    return;
  }

  if (ts.isPropertyAccessExpression(node)) {
    collectEntityReference(node.expression, sourceFile, references);
    pushReference(node.name.text, "method", sourceFile, node.name, references);
  }
}

function collectTypeNameReference(
  node: ts.EntityName,
  sourceFile: ts.SourceFile,
  references: SymbolFact[]
): void {
  references.push({
    name: node.getText(sourceFile),
    kind: "type",
    line: lineOf(sourceFile, node)
  });
}

function collectJsxTagReference(
  node: ts.JsxTagNameExpression,
  sourceFile: ts.SourceFile,
  references: SymbolFact[]
): void {
  if (ts.isIdentifier(node)) {
    pushReference(node.text, "component", sourceFile, node, references);
  } else if (ts.isPropertyAccessExpression(node)) {
    collectEntityReference(node, sourceFile, references);
  }
}

function pushReference(
  name: string,
  kind: SymbolKind,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  references: SymbolFact[]
): void {
  references.push({
    name,
    kind,
    line: lineOf(sourceFile, node)
  });
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

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function componentNameFrom(filePath: string): string {
  const stem = path.posix.basename(normalizePath(filePath)).replace(/\.[^.]+$/u, "");
  return stem
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
}
