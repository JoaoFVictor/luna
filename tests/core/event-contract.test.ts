import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const runtimeFiles = [
  "src/core/workflow-scheduler.ts",
  "src/core/configured-workflow-runner.ts",
  "src/core/run-lock-manager.ts",
  "src/workflows/luna.ts"
];

describe("luna event contract", () => {
  it("does not emit old underscore-style scheduler, run, or lock event names", async () => {
    const combined = (
      await Promise.all(runtimeFiles.map((file) => readFile(file, "utf8")))
    ).join("\n");

    expect(combined).not.toContain("luna.scheduler.step_started");
    expect(combined).not.toContain("luna.scheduler.step_finished");
    expect(combined).not.toContain("luna.scheduler.step_failed");
    expect(combined).not.toContain("luna.run.succeeded");
    expect(combined).not.toContain("luna.run.failed");
    expect(combined).not.toContain("luna.lock.heartbeat_failed");
  });
});
