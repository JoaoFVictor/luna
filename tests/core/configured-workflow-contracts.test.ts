import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../../src/core/artifact-store.js";
import {
  configuredWorkflowBootstrap,
  loadConfigs
} from "../../src/core/configured-workflow/bootstrap.js";
import {
  createFailureArtifactWriter
} from "../../src/core/configured-workflow/failure-artifacts.js";
import {
  configuredWorkflowFinalizer
} from "../../src/core/configured-workflow/finalization.js";
import {
  createObservabilityPort,
  createRunLockPort
} from "../../src/core/configured-workflow/ports.js";
import {
  configuredWorkflowRunner
} from "../../src/core/configured-workflow/runner.js";
import {
  createLunaObservability,
  customEvent
} from "../../src/core/observability/luna-observability.js";
import {
  githubRun,
  invocation,
  readJson,
  staticRunIdentity,
  writeBaseConfig,
  writePreflightWorkflow
} from "./configured-workflow-runner-test-helpers.js";

describe("configured workflow contracts", () => {
  it("uses the real bootstrap adapter to create a runtime-neutral run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-contracts-"));

    try {
      await writeBaseConfig(root);
      await writePreflightWorkflow(root, "code-review");
      const configs = await loadConfigs(root);

      const bootstrapped = await configuredWorkflowBootstrap.bootstrap({
        invocation,
        configRoot: root,
        runtimeRunId: "runtime-1",
        observabilitySinks: [],
        dependencies: {
          createRunIdentity: staticRunIdentity({
            ...githubRun,
            run_id: "run-contract",
            flue_run_id: "runtime-1"
          }),
          ArtifactStore
        },
        attempt: 1,
        date: new Date("2026-06-20T00:00:00.000Z"),
        nonce: "contract",
        configs
      });

      expect(bootstrapped.run).toMatchObject({
        run_id: "run-contract",
        flue_run_id: "runtime-1"
      });
      await expect(
        readJson(root, "code-review", "run-contract", "run.json")
      ).resolves.toMatchObject({ run_id: "run-contract" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the real failure artifact writer instead of bootstrap recovery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-contracts-"));

    try {
      await writeBaseConfig(root);
      const configs = await loadConfigs(root);
      const writer = createFailureArtifactWriter({
        Store: ArtifactStore,
        configs,
        makeRunIdentity: staticRunIdentity({
          ...githubRun,
          run_id: "run-failure",
          workflow_id: "missing-workflow"
        })
      });

      const result = await writer.writeFailure({
        invocation,
        workflowId: "missing-workflow",
        runtimeRunId: "runtime-failure",
        attempt: 1,
        date: new Date("2026-06-20T00:00:00.000Z"),
        nonce: "failure",
        error: Object.assign(new Error("missing workflow"), {
          code: "workflow_config_read_failed"
        })
      });

      expect(result).toMatchObject({
        runtimeRunId: "runtime-failure",
        workflowId: "missing-workflow",
        run: { run_id: "run-failure" },
        error: { code: "workflow_config_read_failed" }
      });
      await expect(
        readJson(root, "missing-workflow", "run-failure", "error.json")
      ).resolves.toMatchObject({ code: "workflow_config_read_failed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("adapts lock and observability ports through real configured workflow adapters", async () => {
    const released: string[] = [];
    const lockPort = createRunLockPort({
      acquire: async (resource) => async () => {
        released.push(resource);
      },
      heartbeat: async () => undefined
    });
    const acquired = await lockPort.acquire({
      runtimeRunId: "runtime-lock",
      resource: "repository:repo"
    });
    await acquired.release();

    const emitted: string[] = [];
    const observability = createLunaObservability({
      run: { id: "run-1", runtimeRunId: "runtime-obs", attempt: 1 },
      workflow: { id: "code-review" },
      sinks: [
        {
          id: "memory",
          required: false,
          append: (event) => {
            emitted.push(event.type);
          }
        }
      ]
    });
    const observabilityPort = createObservabilityPort(observability);
    await observabilityPort.emit({
      runtimeRunId: "runtime-obs",
      event: customEvent({
        ...observability.eventContext("info"),
        type: "luna.contract"
      })
    });

    expect(released).toEqual(["repository:repo"]);
    expect(await lockPort.heartbeat({ runtimeRunId: "runtime-lock" })).toBe(
      "runtime-lock"
    );
    expect(emitted).toEqual(["luna.contract"]);
  });

  it("runs through the configured workflow runner contract with runtimeRunId", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-contracts-"));

    try {
      await writeBaseConfig(root);
      await writePreflightWorkflow(root, "code-review");

      const result = await configuredWorkflowRunner.run({
        invocation,
        configRoot: root,
        runtimeRunId: "runtime-runner",
        nonceFactory: () => "runner",
        dependencies: {
          now: () => new Date("2026-06-20T00:00:00.000Z"),
          createRunIdentity: staticRunIdentity({
            ...githubRun,
            run_id: "run-runner",
            flue_run_id: "runtime-runner"
          }),
          runBuiltInStep: vi.fn(async () => ({ status: "ok" }))
        }
      });

      expect(result.status).toBe("success");
      expect(result.run).toMatchObject({
        run_id: "run-runner",
        flue_run_id: "runtime-runner"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exports the concrete finalizer adapter behind the configured workflow contract", () => {
    expect(configuredWorkflowFinalizer).toMatchObject({
      finalizeSuccessWorkspace: expect.any(Function),
      finalizeFailureWorkspace: expect.any(Function)
    });
  });
});
