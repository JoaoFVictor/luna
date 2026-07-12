import { describe, expect, it, vi } from "vitest";
import type { CheckpointStore } from "../../../src/core/runtime/backends/contracts.js";
import {
  RuntimeDurabilityRecoveryRequiredError,
  runtimeDurabilityRecoveryRequiredFrom
} from "../../../src/core/runtime/errors.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import { runCompiledWorkflow } from "../../../src/runtime/langgraph/workflow-runner.js";
import {
  CheckpointWriteAcceptanceUnknownError,
  nodeOutputCheckpointId
} from "../../../src/runtime/workflow/checkpoints.js";
import {
  runnerAgentRuntime,
  runnerBackends,
  runnerRegistry,
  runnerWorkflow
} from "./runner-test-support.js";

describe("LangGraph concurrent durability aggregation", () => {
  it("finds durability through cyclic aggregates and error causes", () => {
    const cyclic = new AggregateError([], "cyclic");
    const recovery = new RuntimeDurabilityRecoveryRequiredError(
      "protocol read unavailable",
      { cause: cyclic }
    );
    const acceptanceUnknown = new CheckpointWriteAcceptanceUnknownError(
      {
        thread_id: "aggregate-durability",
        checkpoint_ns: "",
        checkpoint_id: "node-output",
        task_id: "uncertain",
        index: 0,
        channel: "steps",
        value: { ok: true }
      },
      new Error("save response lost"),
      new Error("readback unavailable")
    );
    cyclic.errors.push(
      cyclic,
      recovery,
      new Error("acceptance wrapper", { cause: acceptanceUnknown })
    );
    const nested = new Error("outer", { cause: cyclic });

    expect(runtimeDurabilityRecoveryRequiredFrom(nested)).toBe(
      acceptanceUnknown
    );
  });

  it("gives durability uncertainty precedence over a concurrent node failure", async () => {
    const definition: WorkflowDefinition = {
      ...runnerWorkflow([
        { id: "uncertain", type: "built_in", uses: "runtime.ok" },
        { id: "normal_failure", type: "built_in", uses: "runtime.ok" }
      ]),
      execution: { max_concurrency: 2 }
    };
    const compiled = compileWorkflow({
      workflow: definition,
      registry: runnerRegistry
    });
    const backends = runnerBackends();
    const durableCheckpoints = backends.checkpoints;
    const runId = "run-parallel-durability-aggregation";
    const uncertainCheckpointId = nodeOutputCheckpointId(
      runId,
      compiled.workflow_id,
      compiled.workflow_revision,
      "uncertain"
    );
    const saveFailure = new Error("save response lost after commit");
    const readbackFailure = new Error("exact readback unavailable");
    let releaseNormalFailure!: () => void;
    const uncertainWriteCommitted = new Promise<void>((resolve) => {
      releaseNormalFailure = resolve;
    });
    let injected = false;
    let rejectExactReadback = false;
    const faultedCheckpoints: CheckpointStore = {
      ...durableCheckpoints,
      async saveWrites(writes) {
        await durableCheckpoints.saveWrites(writes);
        if (
          !injected &&
          writes.some(
            (write) =>
              write.checkpoint_id === uncertainCheckpointId &&
              write.task_id === "uncertain" &&
              write.index === 0
          )
        ) {
          injected = true;
          rejectExactReadback = true;
          releaseNormalFailure();
          throw saveFailure;
        }
      },
      async listWrites(threadId, checkpointNs, checkpointId) {
        if (
          rejectExactReadback &&
          checkpointId === uncertainCheckpointId
        ) {
          rejectExactReadback = false;
          throw readbackFailure;
        }
        return await durableCheckpoints.listWrites(
          threadId,
          checkpointNs,
          checkpointId
        );
      }
    };
    backends.checkpoints = faultedCheckpoints;
    let uncertainExecutions = 0;
    let normalExecutions = 0;
    const failedState = vi.fn();
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
      builtIns: {
        "runtime.ok": async ({ node }: { node: { id: string } }) => {
          if (node.id === "uncertain") {
            uncertainExecutions += 1;
            return { ok: true };
          }
          normalExecutions += 1;
          if (normalExecutions === 1) {
            await uncertainWriteCommitted;
            throw new Error("ordinary concurrent node failure");
          }
          return { ok: true };
        }
      },
      agentRuntime: runnerAgentRuntime({}),
      onFailedState: failedState
    };

    const inconclusive = await runCompiledWorkflow(input).catch(
      (cause: unknown) => cause
    );
    expect(inconclusive).toBeInstanceOf(
      CheckpointWriteAcceptanceUnknownError
    );
    expect(inconclusive).toMatchObject({
      code: "runtime_checkpoint_write_acceptance_unknown",
      saveCause: saveFailure,
      verificationCause: readbackFailure
    });
    expect(uncertainExecutions).toBe(1);
    expect(normalExecutions).toBe(1);
    expect(failedState).not.toHaveBeenCalled();
    await expect(backends.checkpoints.load(runId, {
      checkpointId: `terminal-${runId}-failed`,
      checkpointNs: ""
    })).resolves.toBeUndefined();
    expect((await backends.events.list(runId)).filter(
      (event) => event.type === "run.failed"
    )).toEqual([]);

    const recovered = await runCompiledWorkflow(input);
    expect(recovered).toMatchObject({
      status: "succeeded",
      state: {
        steps: {
          uncertain: { ok: true },
          normal_failure: { ok: true }
        }
      }
    });
    expect(uncertainExecutions).toBe(1);
    expect(normalExecutions).toBe(2);
    expect(failedState).not.toHaveBeenCalled();
  });
});
