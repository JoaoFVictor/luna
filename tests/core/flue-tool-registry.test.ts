import { describe, expect, it } from "vitest";
import { resolveFlueTools } from "../../src/core/flue-tool-registry.js";

describe("flue tool registry", () => {
  it("resolves registered repository tools", () => {
    const tools = resolveFlueTools({
      ids: ["repository.status", "repository.diff-summary"],
      cwd: "/repo/worktree"
    });

    expect(tools).toHaveLength(2);
  });

  it("rejects unknown tool ids", () => {
    expect(() => {
      resolveFlueTools({
        ids: ["repository.delete-everything"],
        cwd: "/repo/worktree"
      });
    }).toThrowError("Unknown Flue tool: repository.delete-everything");

    try {
      resolveFlueTools({
        ids: ["repository.delete-everything"],
        cwd: "/repo/worktree"
      });
    } catch (error) {
      expect(error).toMatchObject({ code: "flue_tool_unknown" });
      return;
    }

    throw new Error("Expected resolveFlueTools to throw");
  });
});
