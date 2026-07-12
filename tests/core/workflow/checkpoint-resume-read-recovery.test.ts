import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import {
  resumeCompiledWorkflow,
  runCompiledWorkflow
} from "../../../src/runtime/langgraph/workflow-runner.js";
import {
  createFaultedWaitBackends,
  interruptWaitRecoveryRegistry,
  interruptWaitRecoveryWorkflow
} from "./interrupt-wait-recovery-test-support.js";

describe("checkpoint resume read recovery", () => {
  it("retries a transient wait-intent preflight read without terminal failure", async () => {
    const runId = "run-resume-write-transient-read";
    const waitingCheckpointId = `checkpoint-${runId}-approve`;
    const stores = createFaultedWaitBackends("none", waitingCheckpointId);
    const compiled = compileWorkflow({
      workflow: interruptWaitRecoveryWorkflow,
      registry: interruptWaitRecoveryRegistry
    });
    const executePre = vi.fn(async () => ({ ready: true }));
    const waiting = await runCompiledWorkflow({
      compiled,
      workflow: interruptWaitRecoveryWorkflow,
      invocation: {},
      config: {},
      run: {
        run_id: runId,
        workflow_id: interruptWaitRecoveryWorkflow.id,
        attempt: 1,
        started_at: "2026-07-11T00:00:00.000Z"
      },
      backends: stores.backends,
      builtIns: { "runtime.pre": executePre },
      agentRuntime: {} as AgentRuntimePort
    });
    if (waiting.status !== "waiting_for_input") {
      throw new Error("Expected workflow to wait for input");
    }
    const failedState = vi.fn();
    const resumeInput = {
      compiled,
      workflow: interruptWaitRecoveryWorkflow,
      checkpoint_id: waiting.checkpoint_id,
      thread_id: runId,
      interrupt_id: waiting.interrupt_id,
      decision: { approved: true },
      backends: stores.backends,
      builtIns: {},
      agentRuntime: {} as AgentRuntimePort,
      onFailedState: failedState
    };

    stores.failNextWaitIntentRead();
    const unavailable = await resumeCompiledWorkflow(resumeInput).catch(
      (cause: unknown) => cause
    );

    expect(unavailable).toMatchObject({
      code: "runtime_durability_recovery_required",
      details: {
        operation: "validate_interrupt_wait_intent",
        checkpoint_id: waiting.checkpoint_id
      }
    });
    expect(executePre).toHaveBeenCalledTimes(1);
    expect(failedState).not.toHaveBeenCalled();
    await expect(stores.durableInterrupts.get(waiting.interrupt_id)).resolves
      .toMatchObject({ status: "pending" });
    await expect(stores.durableCheckpoints.load(runId, {
      checkpointId: `terminal-${runId}-failed`,
      checkpointNs: ""
    })).resolves.toBeUndefined();
    expect((await stores.backends.events.list(runId)).filter(
      (event) => event.type === "run.failed" || event.type === "node.failed"
    )).toEqual([]);

    await expect(resumeCompiledWorkflow(resumeInput)).resolves.toMatchObject({
      status: "succeeded",
      state: {
        run_status: "succeeded",
        steps: { pre: { ready: true }, approve: { approved: true } }
      }
    });
    expect(executePre).toHaveBeenCalledTimes(1);
    expect(failedState).not.toHaveBeenCalled();
  });
});
