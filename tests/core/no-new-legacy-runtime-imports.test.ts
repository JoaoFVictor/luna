import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const LEGACY_RUNTIME_IMPORTS = [
  "core/configured-workflow",
  "configured-workflow/",
  "core/agent-runtime/flue",
  "core/workflow/scheduler",
  "workflow/scheduler"
];
const SCANNED_NEW_RUNTIME_DIRECTORIES = [
  "src/runtime",
  "src/capabilities"
];
const SCANNED_NEW_RUNTIME_FILES = [
  "src/core/workflow/compiler.ts",
  "src/core/workflow/runner.ts"
];
const TASK_18_EXPIRING_WHITELIST = new Set([
  "src/runtime/composition/target-executor.ts"
]);

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

describe("runtime rebuild import boundaries", () => {
  it("prevents new runtime/composition/compiler/capability modules from importing legacy configured workflow or scheduler runtime", async () => {
    const discoveredFiles = (
      await Promise.all(SCANNED_NEW_RUNTIME_DIRECTORIES.map(listTypeScriptFiles))
    ).flat();
    const files = [
      ...discoveredFiles,
      ...(await existingFiles(SCANNED_NEW_RUNTIME_FILES))
    ];
    const violations: string[] = [];

    await Promise.all(
      files.map(async (file) => {
        if (TASK_18_EXPIRING_WHITELIST.has(file)) {
          return;
        }

        const source = await readFile(path.join(ROOT, file), "utf8");
        if (LEGACY_RUNTIME_IMPORTS.some((needle) => source.includes(needle))) {
          violations.push(file);
        }
      })
    );

    expect(violations).toEqual([]);
  });
});
