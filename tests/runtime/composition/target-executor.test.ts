import { describe, expect, it, vi } from "vitest";
import {
  createLunaTargetExecutor,
  resolveRuntimeConfigRoot
} from "../../../src/runtime/composition/target-executor.js";

describe("TargetExecutor", () => {
  it("delegates a resolved workflow target to the native Luna workflow runner", async () => {
    const runWorkflow = vi.fn(async () => undefined);
    const executor = createLunaTargetExecutor({
      projectRoot: "/repo",
      configRoot: "/repo/config",
      runWorkflow
    });

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

    expect(runWorkflow).toHaveBeenCalledWith({
      projectRoot: "/repo",
      configRoot: "/repo/config",
      invocation: {
        version: "2026-06",
        source: "github",
        event: "pull_request"
      },
      target: { type: "workflow", id: "code-review" }
    });
  });

  it("resolves relative and absolute config roots", () => {
    expect(resolveRuntimeConfigRoot("/repo", {})).toBe("/repo/config");
    expect(
      resolveRuntimeConfigRoot("/repo", { LUNA_CONFIG_ROOT: "/tmp/luna-config" })
    ).toBe("/tmp/luna-config");
  });
});
