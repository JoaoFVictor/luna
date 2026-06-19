import { afterEach, describe, expect, it, vi } from "vitest";

async function importRegistryWithGitMock() {
  vi.resetModules();
  const runGit = vi.fn(async () => "");
  vi.doMock("../../src/core/git.js", () => ({ runGit }));

  const registry = await import("../../src/core/flue-tool-registry.js");

  return { ...registry, runGit };
}

describe("flue tool registry", () => {
  afterEach(() => {
    vi.doUnmock("../../src/core/git.js");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("resolves registered repository tools", async () => {
    const { resolveFlueTools } = await importRegistryWithGitMock();
    const tools = resolveFlueTools({
      ids: ["repository.status", "repository.diff-summary"],
      cwd: "/repo/worktree"
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "repository_status",
      "repository_diff_summary"
    ]);
    expect(tools).toHaveLength(2);
  });

  it("executes repository tools through git with bound cwd", async () => {
    const { resolveFlueTools, runGit } = await importRegistryWithGitMock();
    runGit.mockResolvedValueOnce(" M src/index.ts\n");
    runGit.mockResolvedValueOnce(" src/index.ts | 2 +-\n");

    const [statusTool, diffSummaryTool] = resolveFlueTools({
      ids: ["repository.status", "repository.diff-summary"],
      cwd: "/repo/worktree"
    });

    await expect(statusTool.execute({})).resolves.toBe(" M src/index.ts\n");
    await expect(diffSummaryTool.execute({})).resolves.toBe(
      " src/index.ts | 2 +-\n"
    );
    expect(runGit).toHaveBeenNthCalledWith(1, "/repo/worktree", [
      "status",
      "--short"
    ]);
    expect(runGit).toHaveBeenNthCalledWith(2, "/repo/worktree", [
      "diff",
      "--stat"
    ]);
  });

  it("rejects unknown tool ids", async () => {
    const { resolveFlueTools } = await importRegistryWithGitMock();
    let caught: unknown;

    try {
      resolveFlueTools({
        ids: ["repository.delete-everything"],
        cwd: "/repo/worktree"
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "flue_tool_unknown",
      message: "Unknown Flue tool: repository.delete-everything"
    });
  });
});
