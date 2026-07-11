import { describe, expect, it, vi } from "vitest";
import type { CheckpointStore } from "../../../src/core/runtime/backends/contracts.js";
import { LUNA_RUNTIME_STATE_SCHEMA_VERSION } from "../../../src/core/runtime/state.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import { runCompiledWorkflow } from "../../../src/runtime/langgraph/workflow-runner.js";
import {
  okOutputSchema,
  runnerAgentRuntime,
  runnerBackends,
  runnerRegistry,
  runnerWorkflow
} from "./runner-test-support.js";

describe("workflow terminal preflight", () => {
  it("treats a transient terminal read as recoverable before execution", async () => {
    const definition = runnerWorkflow(
      [{ id: "effect", type: "built_in", uses: "runtime.ok" }],
      okOutputSchema
    );
    const compiled = compileWorkflow({
      workflow: definition,
      registry: runnerRegistry
    });
    const durableBackends = runnerBackends();
    let failTerminalRead = true;
    const checkpoints: CheckpointStore = {
      ...durableBackends.checkpoints,
      async load(threadId, options) {
        if (
          failTerminalRead &&
          options?.checkpointId?.endsWith("-succeeded")
        ) {
          failTerminalRead = false;
          throw new Error("terminal checkpoint storage temporarily unavailable");
        }
        return await durableBackends.checkpoints.load(threadId, options);
      }
    };
    const backends = { ...durableBackends, checkpoints };
    const execute = vi.fn(async () => ({ ok: true }));
    const runId = "run-terminal-preflight-transient-read";
    const input = {
      compiled,
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: runId,
        workflow_id: definition.id,
        attempt: 1,
        started_at: "2026-07-11T00:00:00.000Z"
      },
      backends,
      builtIns: { "runtime.ok": execute },
      agentRuntime: runnerAgentRuntime({})
    };

    await expect(runCompiledWorkflow(input)).rejects.toMatchObject({
      code: "runtime_durability_recovery_required",
      details: {
        operation: "load_terminal_preflight",
        checkpoint_id: `terminal-${runId}-succeeded`
      }
    });
    expect(execute).not.toHaveBeenCalled();
    await expect(durableBackends.checkpoints.load(runId, {
      checkpointId: `terminal-${runId}-failed`,
      checkpointNs: ""
    })).resolves.toBeUndefined();

    await expect(runCompiledWorkflow(input)).resolves.toMatchObject({
      status: "succeeded",
      output: { ok: true }
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("never revives a failed run or creates a conflicting success terminal", async () => {
    const definition = runnerWorkflow(
      [{ id: "effect", type: "built_in", uses: "runtime.ok" }],
      okOutputSchema
    );
    const compiled = compileWorkflow({
      workflow: definition,
      registry: runnerRegistry
    });
    const backends = runnerBackends();
    const runId = "run-terminal-preflight-failed";
    const firstFailure = new Error("first execution failed");
    const execute = vi.fn()
      .mockRejectedValueOnce(firstFailure)
      .mockResolvedValue({ ok: true });
    const input = {
      compiled,
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: runId,
        workflow_id: definition.id,
        attempt: 1,
        started_at: "2026-07-11T00:00:00.000Z"
      },
      backends,
      builtIns: { "runtime.ok": execute },
      agentRuntime: runnerAgentRuntime({})
    };

    await expect(runCompiledWorkflow(input)).rejects.toBe(firstFailure);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(backends.checkpoints.load(runId, {
      checkpointId: `terminal-${runId}-failed`,
      checkpointNs: ""
    })).resolves.toMatchObject({
      state: { run_status: "failed" },
      metadata: { workflow_revision: definition.revision }
    });

    await expect(runCompiledWorkflow(input)).rejects.toMatchObject({
      code: "runtime_state_invalid",
      details: {
        checkpoint_id: `terminal-${runId}-failed`,
        run_status: "failed",
        thread_id: runId
      }
    });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(backends.checkpoints.load(runId, {
      checkpointId: `terminal-${runId}-succeeded`,
      checkpointNs: ""
    })).resolves.toBeUndefined();
  });

  it("rejects conflicting succeeded and failed terminals as integrity loss", async () => {
    const definition = runnerWorkflow(
      [{ id: "effect", type: "built_in", uses: "runtime.ok" }],
      okOutputSchema
    );
    const compiled = compileWorkflow({
      workflow: definition,
      registry: runnerRegistry
    });
    const backends = runnerBackends();
    const runId = "run-conflicting-terminals";
    for (const status of ["succeeded", "failed"] as const) {
      await backends.checkpoints.save({
        thread_id: runId,
        checkpoint_ns: "",
        checkpoint_id: `terminal-${runId}-${status}`,
        state_schema_version: LUNA_RUNTIME_STATE_SCHEMA_VERSION,
        state: {
          state_schema_version: LUNA_RUNTIME_STATE_SCHEMA_VERSION,
          run_status: status,
          artifact_refs: [],
          interrupt_refs: []
        },
        metadata: {
          source: "terminal",
          workflow_revision: definition.revision,
          run_status: status
        }
      });
    }
    const execute = vi.fn(async () => ({ ok: true }));

    await expect(runCompiledWorkflow({
      compiled,
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: runId,
        workflow_id: definition.id,
        attempt: 1,
        started_at: "2026-07-11T00:00:00.000Z"
      },
      backends,
      builtIns: { "runtime.ok": execute },
      agentRuntime: runnerAgentRuntime({})
    })).rejects.toMatchObject({
      code: "runtime_checkpoint_schema_mismatch",
      details: {
        reason: "conflicting_terminal_checkpoints",
        thread_id: runId
      }
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
