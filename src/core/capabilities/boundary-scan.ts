import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export type BoundaryViolationRule =
  | "no-core-to-capabilities-import"
  | "no-core-filesystem-backend-import"
  | "no-core-runtime-import"
  | "no-core-provider-import"
  | "no-core-provider-sdk-import"
  | "no-core-shell-import"
  | "no-core-git-import"
  | "no-core-change-request-provider-import"
  | "no-core-workflow-specific-import";

export type BoundaryViolation = {
  readonly file: string;
  readonly import_path: string;
  readonly rule: BoundaryViolationRule;
};

export type BoundaryScanResult = {
  readonly scanned_files: readonly string[];
  readonly violations: readonly BoundaryViolation[];
};

export type BoundaryScanOptions = {
  readonly repositoryRoot?: string;
  readonly coreRelativePath?: string;
};

const PROVIDER_SDK_PREFIXES = [
  "@earendil-works/pi-ai",
  "@octokit/",
  "octokit",
  "jira.js",
  "node-fetch"
] as const;

const RUNTIME_PACKAGE_PREFIXES = [
  "@langchain/langgraph",
  "langgraph",
  "@openai/agents",
  "@openai/agents-core"
] as const;

const VIOLATION_RULE_ORDER: readonly BoundaryViolationRule[] = [
  "no-core-to-capabilities-import",
  "no-core-filesystem-backend-import",
  "no-core-runtime-import",
  "no-core-provider-sdk-import",
  "no-core-change-request-provider-import",
  "no-core-provider-import",
  "no-core-shell-import",
  "no-core-git-import",
  "no-core-workflow-specific-import"
];

export async function scanCoreCapabilityBoundaries(): Promise<BoundaryScanResult> {
  return await scanCoreImportBoundaries({
    coreRelativePath: "src/core/capabilities"
  });
}

export async function scanCoreImportBoundaries(
  options: BoundaryScanOptions = {}
): Promise<BoundaryScanResult> {
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const coreRelativePath = options.coreRelativePath ?? "src/core";
  const coreRoot = path.join(repositoryRoot, coreRelativePath);
  const files = await collectTypeScriptFiles(coreRoot);
  const violations: BoundaryViolation[] = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const relativeFile = path.relative(repositoryRoot, file);
    for (const importPath of extractImports(source)) {
      const rule = classifyForbiddenImport(importPath, file, repositoryRoot);
      if (rule) {
        violations.push({
          file: relativeFile,
          import_path: importPath,
          rule
        });
      }
    }
  }

  return {
    scanned_files: files.map((file) => path.relative(repositoryRoot, file)),
    violations: violations.sort(compareViolations)
  };
}

function compareViolations(left: BoundaryViolation, right: BoundaryViolation): number {
  const leftRule = VIOLATION_RULE_ORDER.indexOf(left.rule);
  const rightRule = VIOLATION_RULE_ORDER.indexOf(right.rule);
  return (
    leftRule - rightRule ||
    left.file.localeCompare(right.file) ||
    left.import_path.localeCompare(right.import_path)
  );
}

function classifyForbiddenImport(
  importPath: string,
  importingFile: string,
  repositoryRoot: string
): BoundaryViolationRule | undefined {
  const resolvedProjectPath = resolveProjectPath(importPath, importingFile, repositoryRoot);

  if (resolvedProjectPath?.startsWith("src/capabilities/")) {
    return "no-core-to-capabilities-import";
  }
  if (resolvedProjectPath?.startsWith("src/runtime/backends/filesystem/")) {
    return "no-core-filesystem-backend-import";
  }
  if (resolvedProjectPath?.startsWith("src/agent-runtimes/")) {
    return "no-core-runtime-import";
  }
  if (
    RUNTIME_PACKAGE_PREFIXES.some((prefix) => importPath.startsWith(prefix))
  ) {
    return "no-core-runtime-import";
  }
  if (PROVIDER_SDK_PREFIXES.some((prefix) => importPath.startsWith(prefix))) {
    return "no-core-provider-sdk-import";
  }
  if (
    resolvedProjectPath?.match(/^src\/providers\/[^/]+\/change-request\//) ||
    resolvedProjectPath?.match(/^src\/core\/providers\/[^/]+\/change-request/)
  ) {
    return "no-core-change-request-provider-import";
  }
  if (
    resolvedProjectPath?.startsWith("src/providers/") ||
    resolvedProjectPath?.startsWith(`src/core/${"providers"}/`)
  ) {
    return "no-core-provider-import";
  }
  if (importPath === "node:child_process" || importPath === "child_process") {
    return "no-core-shell-import";
  }
  if (
    importPath === "simple-git" ||
    resolvedProjectPath?.startsWith("src/capabilities/git/") ||
    resolvedProjectPath?.startsWith("src/capabilities/repository-change/")
  ) {
    return "no-core-git-import";
  }
  if (
    resolvedProjectPath?.startsWith("src/workflows/") ||
    resolvedProjectPath?.startsWith(`src/core/configured-${"workflow"}/`)
  ) {
    return "no-core-workflow-specific-import";
  }

  return undefined;
}

async function collectTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

function extractImports(source: string): string[] {
  const imports: string[] = [];

  const sourceFile = ts.createSourceFile(
    "boundary-scan.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      imports.push(node.moduleReference.expression.text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

function resolveProjectPath(
  importPath: string,
  importingFile: string,
  repositoryRoot: string
): string | undefined {
  if (importPath.startsWith(".")) {
    const resolved = path.resolve(path.dirname(importingFile), importPath);
    return normalizeProjectPath(stripKnownExtension(path.relative(repositoryRoot, resolved)));
  }
  if (importPath.startsWith("src/")) {
    return normalizeProjectPath(stripKnownExtension(importPath));
  }
  return undefined;
}

function stripKnownExtension(projectPath: string): string {
  return projectPath.replace(/\.(?:js|ts|mjs|mts|cjs|cts)$/, "");
}

function normalizeProjectPath(projectPath: string): string {
  return projectPath.split(path.sep).join("/");
}
