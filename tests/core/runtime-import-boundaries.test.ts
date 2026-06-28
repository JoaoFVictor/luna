import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const FORBIDDEN_RUNTIME_TARGETS = [
  "src/agent-runtimes/",
  "src/providers/"
];
const FORBIDDEN_CAPABILITY_TARGETS = [
  "src/runtime/"
];
const FORBIDDEN_CORE_TARGETS = [
  "src/capabilities/"
];
const SCANNED_RUNTIME_DIRECTORIES = [
  "src/core",
  "src/runtime",
  "src/capabilities"
];
const SCANNED_RUNTIME_FILES = [
  "src/core/workflow/compiler.ts",
  "src/core/workflow/runner-port.ts",
  "src/runtime/langgraph/workflow-runner.ts"
];
const LANGGRAPH_FREE_DIRECTORIES = [
  "src/core",
  "src/runtime/workflow"
];
const FORBIDDEN_LANGGRAPH_PACKAGES = [
  "@langchain/langgraph",
  "@langchain/langgraph-checkpoint",
  "langgraph"
];
const FORBIDDEN_LANGGRAPH_LOCAL_TARGETS = [
  "src/runtime/langgraph/",
  "src/runtime/backends/sqlite/langgraph-checkpointer.ts"
];

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(ROOT, directory), {
    withFileTypes: true
  });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return await listTypeScriptFiles(relativePath);
      }

      return entry.isFile() && relativePath.endsWith(".ts")
        ? [relativePath]
        : [];
    })
  );

  return nested.flat();
}

async function existingFiles(files: string[]): Promise<string[]> {
  const checks = await Promise.all(
    files.map(async (file) => {
      try {
        await access(path.join(ROOT, file));
        return file;
      } catch {
        return undefined;
      }
    })
  );

  return checks.filter((file): file is string => file !== undefined);
}

function extractImports(source: string): string[] {
  const imports: string[] = [];
  const sourceFile = ts.createSourceFile(
    "runtime-import-boundary.ts",
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
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

function resolvedProjectImport(importPath: string, importingFile: string): string | undefined {
  if (!importPath.startsWith(".")) {
    return undefined;
  }

  const resolved = path.normalize(path.join(path.dirname(importingFile), importPath));
  const withoutExtension = resolved.replace(/\.(js|ts)$/, "");
  return withoutExtension.startsWith("src/")
    ? `${withoutExtension}.ts`
    : undefined;
}

describe("runtime import boundaries", () => {
  it("keeps runtime, composition, compiler, and capability modules on approved boundaries", async () => {
    const discoveredFiles = (
      await Promise.all(SCANNED_RUNTIME_DIRECTORIES.map(listTypeScriptFiles))
    ).flat();
    const files = [
      ...discoveredFiles,
      ...(await existingFiles(SCANNED_RUNTIME_FILES))
    ];
    const violations: string[] = [];

    await Promise.all(
      files.map(async (file) => {
        const source = await readFile(path.join(ROOT, file), "utf8");
        for (const importPath of extractImports(source)) {
          const resolved = resolvedProjectImport(importPath, file);
          if (resolved === undefined) {
            continue;
          }
          if (forbiddenTargetsFor(file).some((target) => resolved.startsWith(target))) {
            violations.push(`${file} -> ${resolved}`);
          }
        }
      })
    );

    expect(violations).toEqual([]);
  });

  it("catches forbidden relative runtime imports in scanned modules", () => {
    expect(
      resolvedProjectImport(
        "../../agent-runtimes/pi/adapter.js",
        "src/runtime/composition/runtime-composition.ts"
      )
    ).toBe("src/agent-runtimes/pi/adapter.ts");
  });

  it("keeps core and the neutral workflow engine free of LangGraph imports", async () => {
    const files = (
      await Promise.all(LANGGRAPH_FREE_DIRECTORIES.map(listTypeScriptFiles))
    ).flat();
    const violations: string[] = [];

    await Promise.all(
      files.map(async (file) => {
        const source = await readFile(path.join(ROOT, file), "utf8");
        for (const importPath of extractImports(source)) {
          if (FORBIDDEN_LANGGRAPH_PACKAGES.some((target) => importPath === target || importPath.startsWith(`${target}/`))) {
            violations.push(`${file} -> ${importPath}`);
            continue;
          }

          const resolved = resolvedProjectImport(importPath, file);
          if (
            resolved !== undefined &&
            FORBIDDEN_LANGGRAPH_LOCAL_TARGETS.some((target) => resolved.startsWith(target))
          ) {
            violations.push(`${file} -> ${resolved}`);
          }
        }
      })
    );

    expect(violations).toEqual([]);
  });
});

function forbiddenTargetsFor(file: string): readonly string[] {
  if (file.startsWith("src/core/") && !file.startsWith("src/core/capabilities/")) {
    return [...FORBIDDEN_RUNTIME_TARGETS, ...FORBIDDEN_CORE_TARGETS];
  }

  return file.startsWith("src/capabilities/")
    ? [...FORBIDDEN_RUNTIME_TARGETS, ...FORBIDDEN_CAPABILITY_TARGETS]
    : FORBIDDEN_RUNTIME_TARGETS;
}
