import { describe, expect, it, vi } from "vitest";
import { createFlueTargetExecutor } from "../../../src/runtime/composition/target-executor.js";

describe("TargetExecutor", () => {
  it("delegates a resolved workflow target to the current composition root", async () => {
    const buildCommand = vi.fn(async (invocation) => ({
      command: "node",
      args: ["flue", JSON.stringify(invocation)]
    }));
    const execute = vi.fn(async () => 0);
    const executor = createFlueTargetExecutor({ buildCommand, execute });

    await expect(
      executor.execute({
        invocation: {
          version: "2026-06",
          source: "github",
          event: "pull_request"
        },
        target: { type: "workflow", id: "code-review" }
      })
    ).resolves.toBe(0);

    expect(buildCommand).toHaveBeenCalledWith({
      version: "2026-06",
      source: "github",
      event: "pull_request",
      target: { type: "workflow", id: "code-review" }
    });
    expect(execute).toHaveBeenCalledWith("node", [
      "flue",
      expect.stringContaining("code-review")
    ]);
  });
});
