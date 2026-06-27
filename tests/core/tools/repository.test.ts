import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  repositoryDeleteFileTool,
  repositoryReadFileTool,
  repositoryWriteFileTool
} from "../../../src/core/tools/repository.js";

async function tempRepository(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "luna-repository-tools-"));
}

describe("repository local tools", () => {
  it("reads files inside the bound worktree with truncation metadata", async () => {
    const cwd = await tempRepository();
    await writeFile(path.join(cwd, "README.md"), "abcdef", "utf8");

    const readFileTool = repositoryReadFileTool.createHandler({ cwd });

    await expect(
      readFileTool({ path: "README.md", max_bytes: 3 })
    ).resolves.toEqual({
      path: "README.md",
      content: "abc",
      bytes: 6,
      truncated: true
    });
  });

  it("rejects file paths outside the bound worktree", async () => {
    const cwd = await tempRepository();
    const readFileTool = repositoryReadFileTool.createHandler({ cwd });

    await expect(readFileTool({ path: "../outside.txt" })).rejects.toMatchObject({
      code: "repository_tool_path_escape"
    });
  });

  it("writes files inside the bound worktree", async () => {
    const cwd = await tempRepository();
    const writeFileTool = repositoryWriteFileTool.createHandler({ cwd });

    await expect(
      writeFileTool({
        path: "src/index.ts",
        content: "export const ok = true;\n",
        create_dirs: true
      })
    ).resolves.toEqual({
      path: "src/index.ts",
      bytes: 24
    });
    await expect(readFile(path.join(cwd, "src/index.ts"), "utf8")).resolves.toBe(
      "export const ok = true;\n"
    );
  });

  it("deletes files inside the bound worktree", async () => {
    const cwd = await tempRepository();
    await writeFile(path.join(cwd, "obsolete.txt"), "old", "utf8");
    const deleteFileTool = repositoryDeleteFileTool.createHandler({ cwd });

    await expect(
      deleteFileTool({
        path: "obsolete.txt"
      })
    ).resolves.toEqual({
      path: "obsolete.txt",
      deleted: true
    });
    await expect(stat(path.join(cwd, "obsolete.txt"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("can treat missing deletes as no-op when requested", async () => {
    const cwd = await tempRepository();
    const deleteFileTool = repositoryDeleteFileTool.createHandler({ cwd });

    await expect(
      deleteFileTool({
        path: "missing.txt",
        missing_ok: true
      })
    ).resolves.toEqual({
      path: "missing.txt",
      deleted: false
    });
  });
});
