import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { RunConfiguredWorkflowOptions } from "../../src/core/configured-workflow/runner.js";
import { gitInvocation } from "../fixtures/git-repo.js";
import { cleanupFlueMocks, importWorkflowWithRunnerMock, resetEnv } from "./flue-test-helpers.js";

describe("flue workflow entrypoint", () => {
  beforeEach(() => {
    resetEnv();
  });

  afterEach(() => {
    cleanupFlueMocks();
  });

  it("exports the luna workflow run function", async () => {
    const workflow = await importWorkflowWithRunnerMock(
      "../../src/workflows/luna.js",
      async () => ({ status: "success" })
    );

    expect(typeof workflow.run).toBe("function");
  });

  it("runs the generic luna workflow without a default workflow id", async () => {
    const runConfiguredWorkflow = vi.fn(
      async (_options: RunConfiguredWorkflowOptions) => ({ status: "success" })
    );
    const workflow = await importWorkflowWithRunnerMock(
      "../../src/workflows/luna.js",
      runConfiguredWorkflow
    );

    await workflow.run({
      id: "flue-1",
      payload: gitInvocation,
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      }
    } as never);

    expect(runConfiguredWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: gitInvocation,
        configRoot: "config",
        projectRoot: process.cwd(),
        flueRunId: "flue-1",
        observabilitySinks: expect.arrayContaining([
          expect.objectContaining({ id: "flue-log", required: false })
        ])
      })
    );
  });

  it("registers configured Pi OAuth providers before running workflows", async () => {
    const runConfiguredWorkflow = vi.fn(
      async (_options: RunConfiguredWorkflowOptions) => ({ status: "success" })
    );
    const registerConfiguredPiOAuthProviders = vi.fn(async () => {});
    const workflow = await importWorkflowWithRunnerMock(
      "../../src/workflows/luna.js",
      runConfiguredWorkflow,
      registerConfiguredPiOAuthProviders
    );

    await workflow.run({ payload: gitInvocation } as never);

    expect(registerConfiguredPiOAuthProviders).toHaveBeenCalledWith({
      configRoot: "config"
    });
    expect(runConfiguredWorkflow).toHaveBeenCalled();
  });
});
