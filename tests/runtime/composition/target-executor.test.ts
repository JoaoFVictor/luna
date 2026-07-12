import { describe, expect, it, vi } from "vitest";
import { createLunaTargetExecutor } from "../../../src/runtime/composition/target-executor.js";

describe("Luna target executor", () => {
  it("passes a JSON-safe invocation to the native workflow runner", async () => {
    const runWorkflow = vi.fn(async () => undefined);
    const executor = createLunaTargetExecutor({
      projectRoot: "/project",
      configRoot: "/config",
      runWorkflow
    });

    await expect(executor.execute({
      target: { type: "workflow", id: "review" },
      invocation: {
        version: "2026-06",
        source: "github",
        event: "pull_request",
        payload: { number: 42 }
      }
    })).resolves.toBe(0);
    expect(runWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: "/project",
      configRoot: "/config",
      invocation: expect.objectContaining({ payload: { number: 42 } })
    }));
  });

  it("rejects non-JSON invocation payloads before invoking the runner", async () => {
    const runWorkflow = vi.fn(async () => undefined);
    const executor = createLunaTargetExecutor({
      projectRoot: "/project",
      configRoot: "/config",
      runWorkflow
    });

    await expect(executor.execute({
      target: { type: "workflow", id: "review" },
      invocation: {
        version: "2026-06",
        source: "github",
        event: "pull_request",
        payload: { invalid: undefined }
      }
    })).rejects.toMatchObject({ code: "runtime_invalid_json" });
    expect(runWorkflow).not.toHaveBeenCalled();
  });
});
