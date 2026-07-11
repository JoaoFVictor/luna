import { describe, expect, it, vi } from "vitest";
import { RuntimeDurabilityRecoveryRequiredError } from "../../../src/core/runtime/errors.js";
import type { LunaRuntimeState } from "../../../src/core/runtime/state.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import {
  runCompiledWorkflow,
  type WorkflowBuiltInExecutor
} from "../../../src/runtime/langgraph/workflow-runner.js";
import {
  okOutputSchema,
  runnerAgentRuntime as agentRuntime,
  runnerBackends as backends,
  runnerRegistry as registry,
  runnerWorkflow as workflow
} from "./runner-test-support.js";

describe("workflow runner terminalization and cleanup", () => {
  it("retains successful workspace evidence during terminalization", async () => {
    const definition = workflow(
      [
        {
          id: "capture",
          type: "built_in",
          uses: "runtime.workspace"
        }
      ],
      {
        type: "object",
        additionalProperties: false,
        required: ["run_id", "path", "preserved", "reason"],
        properties: {
          run_id: { type: "string" },
          path: { type: "string" },
          preserved: { type: "boolean" },
          reason: { type: "string" }
        }
      }
    );

    const result = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-workspace-cleanup",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      runtimeContext: {
        repository: { id: "repo-1" },
        workspaceRoot: "/tmp/workspaces"
      },
      backends: backends(),
      builtIns: {
        "runtime.workspace": () => ({
          run_id: "run-workspace-cleanup",
          path: "/tmp/workspaces/repo-1/run-workspace-cleanup",
          preserved: true,
          reason: "created"
        })
      },
      builtInMetadata: (node) =>
        node.capability_id === "runtime.workspace"
          ? { capturesWorkspace: true }
          : {},
      agentRuntime: agentRuntime({})
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("expected workflow to succeed");
    }
    expect(result.output).toMatchObject({
      preserved: true,
      reason: "created"
    });
    expect(result.state.steps.capture).toMatchObject({
      preserved: true,
      reason: "created"
    });
  });

  it("commits the control-plane terminal intent before its secondary runtime checkpoint", async () => {
    const stores = backends();
    const checkpointStore = stores.checkpoints;
    const order: string[] = [];
    const definition = workflow(
      [{ id: "ok", type: "built_in", uses: "runtime.ok" }],
      okOutputSchema
    );

    const result = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-control-plane-authority-order",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: {
        ...stores,
        checkpoints: {
          ...checkpointStore,
          async save(input) {
            if (input.metadata?.run_status === "succeeded") {
              order.push("runtime_checkpoint");
            }
            return await checkpointStore.save(input);
          }
        }
      },
      builtIns: { "runtime.ok": async () => ({ ok: true }) },
      agentRuntime: agentRuntime({}),
      onSucceededState: async () => {
        order.push("control_plane_terminal");
      }
    });

    expect(result.status).toBe("succeeded");
    expect(order).toEqual(["control_plane_terminal", "runtime_checkpoint"]);
  });

  it("leaves terminal recovery to the control plane when its barrier fails", async () => {
    const stores = backends();
    const checkpointStore = stores.checkpoints;
    const barrierFailure = new Error("terminal journal unavailable");
    const terminalCheckpointSaves = vi.fn();
    const failedState = vi.fn();
    const definition = workflow(
      [{ id: "ok", type: "built_in", uses: "runtime.ok" }],
      okOutputSchema
    );

    await expect(runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-control-plane-barrier-fails",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: {
        ...stores,
        checkpoints: {
          ...checkpointStore,
          async save(input) {
            if (input.metadata?.run_status === "succeeded") {
              terminalCheckpointSaves();
            }
            return await checkpointStore.save(input);
          }
        }
      },
      builtIns: { "runtime.ok": async () => ({ ok: true }) },
      agentRuntime: agentRuntime({}),
      onSucceededState: async () => {
        throw barrierFailure;
      },
      onFailedState: failedState
    })).rejects.toBe(barrierFailure);

    expect(terminalCheckpointSaves).not.toHaveBeenCalled();
    expect(failedState).not.toHaveBeenCalled();
  });

  it("rejects final workflow output before marking the run succeeded", async () => {
    const stores = backends();
    const definition = workflow(
      [{ id: "ok", type: "built_in", uses: "runtime.ok" }],
      {
        type: "object",
        additionalProperties: false,
        required: ["final"],
        properties: { final: { type: "boolean" } }
      }
    );
    let observedFailure: LunaRuntimeState | undefined;

    await expect(
      runCompiledWorkflow({
        compiled: compileWorkflow({ workflow: definition, registry }),
        workflow: definition,
        invocation: {},
        config: {},
        run: {
          run_id: "run-final-invalid",
          workflow_id: "runner-test",
          attempt: 1,
          started_at: "2026-06-25T00:00:00.000Z"
        },
        backends: stores,
        builtIns: { "runtime.ok": async () => ({ ok: true }) },
        agentRuntime: agentRuntime({}),
        onFailedState: (state) => {
          observedFailure = state;
        }
      })
    ).rejects.toMatchObject({ code: "runtime_node_output_schema_invalid" });
    expect(observedFailure).toMatchObject({
      run_status: "failed",
      node_statuses: { ok: { status: "succeeded", attempt: 1 } },
      attempts: {
        ok: {
          count: 1,
          history: [{ attempt: 1, status: "succeeded" }]
        }
      }
    });
    expect(observedFailure?.primary_failure).toBeUndefined();
    await expect(stores.checkpoints.load("run-final-invalid")).resolves.toMatchObject({
      state: { run_status: "failed" }
    });
    expect((await stores.events.list("run-final-invalid")).map((event) => event.type)).not.toContain(
      "run.succeeded"
    );
  });

  it("requires recovery without publishing failed when the failed terminal is not durable", async () => {
    const stores = backends();
    const checkpointStore = stores.checkpoints;
    const runtimeFailure = new Error("external effect response failed");
    const checkpointFailure = new Error("failed terminal unavailable");
    const failedState = vi.fn();
    const definition = workflow(
      [{ id: "effect", type: "built_in", uses: "runtime.ok" }],
      okOutputSchema
    );

    const outcome = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-failed-terminal-unknown",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: {
        ...stores,
        checkpoints: {
          ...checkpointStore,
          async save(input) {
            if (input.metadata?.run_status === "failed") {
              throw checkpointFailure;
            }
            return await checkpointStore.save(input);
          }
        }
      },
      builtIns: {
        "runtime.ok": async () => {
          throw runtimeFailure;
        }
      },
      agentRuntime: agentRuntime({}),
      onFailedState: failedState
    }).catch((cause: unknown) => cause);

    expect(outcome).toBeInstanceOf(RuntimeDurabilityRecoveryRequiredError);
    expect(outcome).toMatchObject({
      code: "runtime_durability_recovery_required",
      cause: checkpointFailure,
      details: {
        run_id: "run-failed-terminal-unknown",
        runtime_failure_kind: "Error"
      }
    });
    expect(failedState).not.toHaveBeenCalled();
    expect((await stores.events.list("run-failed-terminal-unknown")))
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "run.failed" })
      ]));
    await expect(checkpointStore.load("run-failed-terminal-unknown", {
      checkpointId: "terminal-run-failed-terminal-unknown-failed"
    })).resolves.toBeUndefined();
  });

  it("leaves recovery open when the success checkpoint cannot commit", async () => {
    const stores = backends();
    const checkpointFailure = new Error("terminal checkpoint unavailable");
    const checkpointStore = stores.checkpoints;
    const definition = workflow(
      [{ id: "ok", type: "built_in", uses: "runtime.ok" }],
      okOutputSchema
    );

    await expect(runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-success-checkpoint-fails",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: {
        ...stores,
        checkpoints: {
          ...checkpointStore,
          async save(input) {
            if (input.metadata?.run_status === "succeeded") {
              throw checkpointFailure;
            }
            return await checkpointStore.save(input);
          }
        }
      },
      builtIns: { "runtime.ok": async () => ({ ok: true }) },
      agentRuntime: agentRuntime({})
    })).rejects.toBe(checkpointFailure);

    await expect(checkpointStore.load("run-success-checkpoint-fails", {
      checkpointId: "terminal-run-success-checkpoint-fails-succeeded"
    })).resolves.toBeUndefined();
    await expect(checkpointStore.load("run-success-checkpoint-fails", {
      checkpointId: "terminal-run-success-checkpoint-fails-failed"
    })).resolves.toBeUndefined();
  });

  it("never writes failed after a succeeded checkpoint has an unknown acknowledgement", async () => {
    const stores = backends();
    const checkpointStore = stores.checkpoints;
    const responseFailure = new Error("checkpoint response and read-back lost");
    const failedTerminalSaves = vi.fn();
    let successSaveAttempted = false;
    const definition = workflow(
      [{ id: "ok", type: "built_in", uses: "runtime.ok" }],
      okOutputSchema
    );

    await expect(runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-success-ack-unknown",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: {
        ...stores,
        checkpoints: {
          ...checkpointStore,
          async save(input) {
            if (input.metadata?.run_status === "failed") {
              failedTerminalSaves();
            }
            const saved = await checkpointStore.save(input);
            if (input.metadata?.run_status === "succeeded") {
              successSaveAttempted = true;
              throw responseFailure;
            }
            return saved;
          },
          async load(threadId, options) {
            if (
              successSaveAttempted &&
              options?.checkpointId?.endsWith("-succeeded") === true
            ) {
              throw responseFailure;
            }
            return await checkpointStore.load(threadId, options);
          }
        }
      },
      builtIns: { "runtime.ok": async () => ({ ok: true }) },
      agentRuntime: agentRuntime({})
    })).rejects.toBe(responseFailure);

    expect(failedTerminalSaves).not.toHaveBeenCalled();
    await expect(checkpointStore.load("run-success-ack-unknown", {
      checkpointId: "terminal-run-success-ack-unknown-succeeded"
    })).resolves.toMatchObject({ state: { run_status: "succeeded" } });
    await expect(checkpointStore.load("run-success-ack-unknown", {
      checkpointId: "terminal-run-success-ack-unknown-failed"
    })).resolves.toBeUndefined();
  });

  it("accepts success when the exact terminal checkpoint committed before save threw", async () => {
    const stores = backends();
    const checkpointStore = stores.checkpoints;
    const closeFailure = new Error("checkpoint connection close failed");
    const definition = workflow(
      [{ id: "ok", type: "built_in", uses: "runtime.ok" }],
      okOutputSchema
    );

    const result = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-success-checkpoint-acceptance-unknown",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: {
        ...stores,
        checkpoints: {
          ...checkpointStore,
          async save(input) {
            const saved = await checkpointStore.save(input);
            if (input.metadata?.run_status === "succeeded") {
              throw closeFailure;
            }
            return saved;
          }
        }
      },
      builtIns: { "runtime.ok": async () => ({ ok: true }) },
      agentRuntime: agentRuntime({})
    });

    expect(result).toMatchObject({
      status: "succeeded",
      state: { run_status: "succeeded" }
    });
    await expect(checkpointStore.load(
      "run-success-checkpoint-acceptance-unknown",
      {
        checkpointId:
          "terminal-run-success-checkpoint-acceptance-unknown-succeeded"
      }
    )).resolves.toMatchObject({ state: { run_status: "succeeded" } });
  });

  it("does not reclassify success after the terminal checkpoint commits", async () => {
    const stores = backends();
    const controller = new AbortController();
    const lateLeaseLoss = new Error("lease lost after terminal commit");
    const checkpointStore = stores.checkpoints;
    const definition = workflow(
      [{ id: "ok", type: "built_in", uses: "runtime.ok" }],
      okOutputSchema
    );

    const result = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-abort-after-terminal",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      signal: controller.signal,
      backends: {
        ...stores,
        checkpoints: {
          ...checkpointStore,
          async save(input) {
            const saved = await checkpointStore.save(input);
            if (input.metadata?.run_status === "succeeded") {
              controller.abort(lateLeaseLoss);
            }
            return saved;
          }
        }
      },
      builtIns: { "runtime.ok": async () => ({ ok: true }) },
      agentRuntime: agentRuntime({})
    });

    expect(controller.signal.reason).toBe(lateLeaseLoss);
    expect(result).toMatchObject({
      status: "succeeded",
      state: { run_status: "succeeded" }
    });
    await expect(checkpointStore.load("run-abort-after-terminal"))
      .resolves.toMatchObject({ state: { run_status: "succeeded" } });
  });

  it("never retries completed work when lifecycle projection fails", async () => {
    const definition = workflow(
      [{ id: "effect", type: "built_in", uses: "runtime.ok" }],
      okOutputSchema
    );
    const executeEffect = vi.fn(async () => ({ ok: true }));
    const projectionFailure = new Error("Studio ledger is unavailable");
    const projectionErrors = vi.fn();

    const result = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-observer-failure",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: backends(),
      builtIns: { "runtime.ok": executeEffect },
      agentRuntime: agentRuntime({}),
      onLifecycleEvent: async (event) => {
        if (event.type === "node.succeeded") {
          throw projectionFailure;
        }
      },
      onLifecycleProjectionError: projectionErrors
    });

    expect(result.status).toBe("succeeded");
    expect(executeEffect).toHaveBeenCalledTimes(1);
    expect(projectionErrors).toHaveBeenCalledTimes(1);
    expect(projectionErrors).toHaveBeenCalledWith(
      projectionFailure,
      expect.objectContaining({
        type: "node.succeeded",
        node_id: "effect",
        attempt: 1
      })
    );
  });

  it("does not start downstream work after its lease signal is lost", async () => {
    const definition = workflow(
      [
        { id: "effect", type: "built_in", uses: "runtime.ok" },
        {
          id: "downstream",
          type: "built_in",
          uses: "runtime.ok",
          after: ["effect"]
        }
      ],
      okOutputSchema
    );
    const controller = new AbortController();
    const leaseLost = new Error("lease lost");
    const executions: string[] = [];
    const executeEffect: WorkflowBuiltInExecutor = async ({ node }) => {
      executions.push(node.id);
      if (node.id === "effect") {
        controller.abort(leaseLost);
      }
      return { ok: true };
    };
    const lifecycle: string[] = [];

    await expect(runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-lease-lost",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      signal: controller.signal,
      backends: backends(),
      builtIns: { "runtime.ok": executeEffect },
      agentRuntime: agentRuntime({}),
      onLifecycleEvent: async (event) => {
        lifecycle.push(`${event.node_id}:${event.type}`);
      }
    })).rejects.toBe(leaseLost);

    expect(executions).toEqual(["effect"]);
    expect(lifecycle).toEqual([
      "effect:node.started",
      "effect:node.failed"
    ]);
  });
});
