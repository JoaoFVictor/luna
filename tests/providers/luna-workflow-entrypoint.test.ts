import { describe, expect, it, vi } from "vitest";
import type { NativeWorkflowRunInput } from "../../src/runtime/composition/target-executor.js";

const runWorkflow = vi.fn(async () => undefined);
const loadNativeLunaPlatform = vi.fn(async () => ({
  inputAdapterRegistry: {
    get: vi.fn(),
    require: vi.fn(),
    ids: vi.fn(() => [])
  },
  runWorkflow
}));

vi.mock("../../src/platform/native/native-platform-loader.js", () => ({
  loadNativeLunaPlatform
}));

describe("Luna workflow entrypoint", () => {
  it("loads the configured native platform before running a workflow", async () => {
    const { run } = await import("../../src/workflows/luna.js");
    const input: NativeWorkflowRunInput = {
      projectRoot: "/project",
      configRoot: "/project/config",
      target: { type: "workflow", id: "implementation" },
      invocation: {
        version: "2026-06",
        source: "manual",
        event: "dispatch"
      }
    };

    await expect(run(input)).resolves.toBeUndefined();

    expect(loadNativeLunaPlatform).toHaveBeenCalledWith({
      projectRoot: "/project",
      configRoot: "/project/config"
    });
    expect(runWorkflow).toHaveBeenCalledWith(input);
  });
});
