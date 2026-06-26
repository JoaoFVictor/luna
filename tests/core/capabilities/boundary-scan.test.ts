import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  scanCoreCapabilityBoundaries,
  scanCoreImportBoundaries
} from "../../../src/core/capabilities/boundary-scan.js";

async function writeFileInRoot(
  root: string,
  relativePath: string,
  contents: string
): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

describe("core capability boundary scanner", () => {
  it("recursively rejects forbidden imports from core TypeScript files", async () => {
    const root = path.join(tmpdir(), `luna-boundary-${Date.now()}`);
    await mkdir(root, { recursive: true });

    await writeFileInRoot(
      root,
      "src/core/capabilities/manifest.ts",
      [
        'import { manifest } from "../../capabilities/context/manifest.js";',
        'const text = "require(\\"@langchain/langgraph\\")";',
        '// import { ignored } from "../../capabilities/git/manifest.js";',
        "export const value = manifest;"
      ].join("\n")
    );
    await writeFileInRoot(
      root,
      "src/core/runtime/backend.ts",
      'import { FilesystemArtifactStore } from "../../runtime/backends/filesystem/artifacts.js";'
    );
    await writeFileInRoot(
      root,
      "src/core/agent-runtime/flue-bridge.ts",
      [
        'import { run } from "@flue/runtime";',
        'import { StateGraph } from "@langchain/langgraph";'
      ].join("\n")
    );
    await writeFileInRoot(
      root,
      "src/core/providers/github.ts",
      [
        'import { Octokit } from "octokit";',
        'import { adapter } from "../../agent-runtimes/flue/adapter.js";',
        'import provider from "../../providers/github/change-request/provider.js";',
        'import legacy from "./github/change-request-actions.js";',
        'const backend = require("../../runtime/backends/filesystem/artifacts.js");',
        'import oldStyle = require("../../capabilities/reports/manifest.js");',
        "export { provider };",
        "export { legacy };",
        "export { adapter };",
        "export { backend };",
        "export { oldStyle };"
      ].join("\n")
    );
    await writeFileInRoot(
      root,
      "src/core/workflow/exports.ts",
      'export { workflow } from "../../workflows/luna.js";'
    );
    await writeFileInRoot(
      root,
      "src/core/workflow/shell.ts",
      'import { spawn } from "node:child_process";'
    );
    await writeFileInRoot(
      root,
      "src/core/git/client.ts",
      'import git from "simple-git";'
    );

    const result = await scanCoreImportBoundaries({ repositoryRoot: root });

    expect(result.violations.map((violation) => violation.rule)).toEqual([
      "no-core-to-capabilities-import",
      "no-core-to-capabilities-import",
      "no-core-filesystem-backend-import",
      "no-core-filesystem-backend-import",
      "no-core-flue-import",
      "no-core-runtime-import",
      "no-core-runtime-import",
      "no-core-provider-sdk-import",
      "no-core-change-request-provider-import",
      "no-core-change-request-provider-import",
      "no-core-shell-import",
      "no-core-git-import",
      "no-core-workflow-specific-import"
    ]);

    expect(result.violations.map((violation) => violation.import_path)).not.toContain(
      "@langchain/langgraph\\"
    );
  });

  it("accepts the current capability core modules", async () => {
    const result = await scanCoreCapabilityBoundaries();

    expect(result.violations).toEqual([]);
  });
});
