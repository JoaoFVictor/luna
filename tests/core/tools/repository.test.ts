import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  repositoryDeleteFileTool,
  repositoryReadFileTool,
  repositoryWriteFileTool
} from "../../../src/capabilities/repository/repository.js";
import {
  writeSecureRepositoryFile
} from "../../../src/capabilities/repository/repository-file-operations.js";
import { manifest as repositoryManifest } from "../../../src/capabilities/repository/manifest.js";

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

  it("does not read through symbolic links inside the worktree", async () => {
    const cwd = await tempRepository();
    const outside = await tempRepository();
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await symlink(path.join(outside, "secret.txt"), path.join(cwd, "secret.txt"));
    const readFileTool = repositoryReadFileTool.createHandler({ cwd });

    await expect(readFileTool({ path: "secret.txt" })).rejects.toMatchObject({
      code: "repository_tool_security_violation"
    });
  });

  it("caps direct bounded reads even when a caller bypasses contract validation", async () => {
    const cwd = await tempRepository();
    await writeFile(path.join(cwd, "large.txt"), "x".repeat(1_048_577), "utf8");
    const readFileTool = repositoryReadFileTool.createHandler({ cwd });

    await expect(readFileTool({
      path: "large.txt",
      max_bytes: 2_000_000
    })).resolves.toMatchObject({
      bytes: 1_048_577,
      truncated: true,
      content: "x".repeat(1_048_576)
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

  it("atomically preserves the previous file and mode when a write fails", async () => {
    const cwd = await tempRepository();
    const target = path.join(cwd, "stable.txt");
    await writeFile(target, "previous\n", { mode: 0o640 });

    await expect(
      writeSecureRepositoryFile({
        cwd,
        requestedPath: "stable.txt",
        content: "replacement\n",
        createDirectories: false,
        faultInjector: (stage) => {
          if (stage === "after_file_synced") {
            throw new Error("injected write failure");
          }
        }
      })
    ).rejects.toThrow("injected write failure");

    await expect(readFile(target, "utf8")).resolves.toBe("previous\n");
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    await expect(readdir(cwd)).resolves.toEqual(["stable.txt"]);

    await writeSecureRepositoryFile({
      cwd,
      requestedPath: "stable.txt",
      content: "replacement\n",
      createDirectories: false
    });
    await expect(readFile(target, "utf8")).resolves.toBe("replacement\n");
    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });

  it("replaces an owner read-only file atomically while preserving its mode", async () => {
    const cwd = await tempRepository();
    const target = path.join(cwd, "read-only.txt");
    await writeFile(target, "previous\n", "utf8");
    await chmod(target, 0o440);

    await writeSecureRepositoryFile({
      cwd,
      requestedPath: "read-only.txt",
      content: "replacement\n",
      createDirectories: false
    });

    await expect(readFile(target, "utf8")).resolves.toBe("replacement\n");
    expect((await stat(target)).mode & 0o777).toBe(0o440);
  });

  it("does not write through file or parent-directory symbolic links", async () => {
    const cwd = await tempRepository();
    const outside = await tempRepository();
    const outsideFile = path.join(outside, "outside.txt");
    await writeFile(outsideFile, "original", "utf8");
    await symlink(outsideFile, path.join(cwd, "linked-file.txt"));
    await symlink(outside, path.join(cwd, "linked-directory"), "dir");
    const writeFileTool = repositoryWriteFileTool.createHandler({ cwd });

    await expect(writeFileTool({
      path: "linked-file.txt",
      content: "overwritten"
    })).rejects.toMatchObject({ code: "repository_tool_security_violation" });
    await expect(writeFileTool({
      path: "linked-directory/created.txt",
      content: "escaped",
      create_dirs: true
    })).rejects.toMatchObject({ code: "repository_tool_not_directory" });

    await expect(readFile(outsideFile, "utf8")).resolves.toBe("original");
    await expect(stat(path.join(outside, "created.txt"))).rejects.toMatchObject({
      code: "ENOENT"
    });
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

  it("does not delete through parent-directory symbolic links", async () => {
    const cwd = await tempRepository();
    const outside = await tempRepository();
    const outsideFile = path.join(outside, "keep.txt");
    await writeFile(outsideFile, "keep", "utf8");
    await symlink(outside, path.join(cwd, "linked-directory"), "dir");
    const deleteFileTool = repositoryDeleteFileTool.createHandler({ cwd });

    await expect(deleteFileTool({
      path: "linked-directory/keep.txt"
    })).rejects.toMatchObject({ code: "repository_tool_not_directory" });
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("keep");
  });

  it("deletes an in-worktree symbolic link without deleting its target", async () => {
    const cwd = await tempRepository();
    const outside = await tempRepository();
    const outsideFile = path.join(outside, "keep.txt");
    const link = path.join(cwd, "linked-file.txt");
    await writeFile(outsideFile, "keep", "utf8");
    await symlink(outsideFile, link);
    const deleteFileTool = repositoryDeleteFileTool.createHandler({ cwd });

    await expect(deleteFileTool({ path: "linked-file.txt" })).resolves.toEqual({
      path: "linked-file.txt",
      deleted: true
    });
    await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("keep");
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

  it("registers only bounded repository status and file operations", () => {
    expect(Object.keys(repositoryManifest.tools).sort()).toEqual([
      "repository.delete-file",
      "repository.diff-summary",
      "repository.read-file",
      "repository.status",
      "repository.write-file"
    ]);
  });
});
