import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      return entry.isDirectory()
        ? await collectTypeScriptFiles(entryPath)
        : entry.name.endsWith(".ts")
          ? [entryPath]
          : [];
    })
  );

  return nested.flat().sort();
}

function importSpecifiers(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "source.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const imports: string[] = [];

  function addSpecifier(specifier: ts.Expression): void {
    if (ts.isStringLiteralLike(specifier)) {
      imports.push(specifier.text);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      addSpecifier(node.moduleSpecifier);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      addSpecifier(node.moduleSpecifier);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

describe("agent runtime boundary", () => {
  it("keeps new core runtime modules free of Flue imports", async () => {
    const files = await collectTypeScriptFiles("src/core/agent-runtime");
    const newCoreFiles = files.filter(
      (file) => !file.includes(`${path.sep}flue${path.sep}`)
    );
    const violations: string[] = [];

    for (const file of newCoreFiles) {
      const imports = importSpecifiers(await readFile(file, "utf8"));
      for (const specifier of imports) {
        if (specifier.startsWith("@flue/") || specifier.includes("/flue")) {
          violations.push(`${file}: ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("does not add a new concrete runtime adapter under src/core", async () => {
    const files = await collectTypeScriptFiles("src/core");
    const concreteAdapters = files.filter(
      (file) =>
        file.includes(`${path.sep}adapter.ts`) &&
        file.includes(`${path.sep}agent-runtime${path.sep}`)
    );

    expect(concreteAdapters).toEqual([]);
  });

  it("keeps legacy Flue in place until Task 18 and creates the new adapter boundary", async () => {
    await expect(exists("src/core/agent-runtime/flue/runner.ts")).resolves.toBe(true);
    await expect(exists("src/core/agent-runtime/flue/capabilities.ts")).resolves.toBe(true);
    await expect(exists("src/core/agent-runtime/flue/workflow-factory.ts")).resolves.toBe(true);
    await expect(exists("src/agent-runtimes/flue/adapter.ts")).resolves.toBe(true);
  });
});
