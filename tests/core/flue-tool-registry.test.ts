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
      agentMode: "trusted_host_local_write",
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
      agentMode: "trusted_host_local_write",
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
        agentMode: "trusted_host_local_write",
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

  it("rejects tools for unsupported agent modes", async () => {
    const { resolveFlueTools } = await importRegistryWithGitMock();
    let caught: unknown;

    try {
      resolveFlueTools({
        ids: ["repository.status"],
        agentMode: "unsupported_mode" as never,
        cwd: "/repo/worktree"
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "flue_tool_mode_not_allowed",
      message: "Flue tool repository.status is not allowed for agent mode unsupported_mode"
    });
  });

  it("exposes safety metadata for every registered Flue tool", async () => {
    const { registeredFlueToolSafety } = await importRegistryWithGitMock();

    expect(registeredFlueToolSafety()).toEqual({
      "repository.status": {
        writes: false,
        network: false,
        side_effects: false
      },
      "repository.diff-summary": {
        writes: false,
        network: false,
        side_effects: false
      }
    });
  });

  it("enforces tool safety invariants", async () => {
    const { assertToolSafety } = await importRegistryWithGitMock();

    expect(() =>
      assertToolSafety({
        writes: true,
        network: false,
        side_effects: false
      })
    ).toThrow(
      "writing tools must declare side_effects"
    );
  });
});
