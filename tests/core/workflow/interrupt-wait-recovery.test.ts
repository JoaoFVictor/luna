import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import { runCompiledWorkflow } from "../../../src/runtime/langgraph/workflow-runner.js";
import {
  createFaultedWaitBackends,
  interruptWaitRecoveryRegistry,
  interruptWaitRecoveryWorkflow,
  WAIT_COMPLETION_CHANNEL,
  WAIT_INTENT_CHANNEL
} from "./interrupt-wait-recovery-test-support.js";

const registry = interruptWaitRecoveryRegistry;
const workflow = interruptWaitRecoveryWorkflow;

describe("interrupt waiting protocol recovery", () => {
  it.each([
    ["intent_write", "runtime_checkpoint_write_acceptance_unknown"],
    ["waiting_checkpoint", "runtime_durability_recovery_required"],
    ["interrupt_create", "runtime_durability_recovery_required"]
  ] as const)(
    "reconciles %s acceptance-unknown without failing or replaying prior work",
    async (stage, expectedCode) => {
      const runId = `run-wait-recovery-${stage}`;
      const waitingCheckpointId = `checkpoint-${runId}-approve`;
      const interruptId = `interrupt-${runId}-approve`;
      const stores = createFaultedWaitBackends(stage, waitingCheckpointId);
      const executePre = vi.fn(async () => ({ ready: true }));
      const failedState = vi.fn();
      const input = {
        compiled: compileWorkflow({ workflow, registry }),
        workflow,
        invocation: {},
        config: {},
        run: {
          run_id: runId,
          workflow_id: workflow.id,
          attempt: 1,
          started_at: "2026-06-25T00:00:00.000Z"
        },
        backends: stores.backends,
        builtIns: { "runtime.pre": executePre },
        agentRuntime: {} as AgentRuntimePort,
        onFailedState: failedState
      };

      const inconclusive = await runCompiledWorkflow(input).catch(
        (cause: unknown) => cause
      );

      expect(inconclusive).toMatchObject({ code: expectedCode });
      expect(executePre).toHaveBeenCalledTimes(1);
      expect(failedState).not.toHaveBeenCalled();
      await expect(stores.durableCheckpoints.load(runId, {
        checkpointId: `terminal-${runId}-failed`,
        checkpointNs: ""
      })).resolves.toBeUndefined();
      const failureEvents = (await stores.backends.events.list(runId)).filter(
        (event) => event.type === "run.failed" || event.type === "node.failed"
      );
      expect(failureEvents).toEqual([]);

      const incompleteOutbox = await stores.durableCheckpoints.listWrites(
        runId,
        "",
        waitingCheckpointId
      );
      expect(incompleteOutbox).toEqual(expect.arrayContaining([
        expect.objectContaining({
          task_id: "__luna_wait_intent__:approve",
          index: 0,
          channel: WAIT_INTENT_CHANNEL
        })
      ]));
      expect(incompleteOutbox).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ channel: WAIT_COMPLETION_CHANNEL })
      ]));

      const recovered = await runCompiledWorkflow(input);

      expect(recovered).toMatchObject({
        status: "waiting_for_input",
        interrupt_id: interruptId,
        checkpoint_id: waitingCheckpointId,
        state: {
          run_status: "waiting_for_input",
          steps: { pre: { ready: true } }
        }
      });
      expect(executePre).toHaveBeenCalledTimes(1);
      await expect(stores.durableInterrupts.list(runId)).resolves.toEqual([
        expect.objectContaining({
          id: interruptId,
          checkpoint_id: waitingCheckpointId,
          status: "pending"
        })
      ]);

      const reconciledOutbox = await stores.durableCheckpoints.listWrites(
        runId,
        "",
        waitingCheckpointId
      );
      expect(reconciledOutbox).toEqual(expect.arrayContaining([
        expect.objectContaining({ channel: WAIT_INTENT_CHANNEL }),
        expect.objectContaining({
          task_id: "__luna_wait_completion__:approve",
          index: 0,
          channel: WAIT_COMPLETION_CHANNEL
        })
      ]));
      await expect(stores.durableCheckpoints.load(runId, {
        checkpointId: `terminal-${runId}-failed`,
        checkpointNs: ""
      })).resolves.toBeUndefined();
    }
  );

  it("keeps a durable wait intent recoverable when replay readback fails once", async () => {
    const runId = "run-wait-intent-transient-replay-read";
    const waitingCheckpointId = `checkpoint-${runId}-approve`;
    const stores = createFaultedWaitBackends(
      "intent_write",
      waitingCheckpointId
    );
    const executePre = vi.fn(async () => ({ ready: true }));
    const failedState = vi.fn();
    const input = {
      compiled: compileWorkflow({ workflow, registry }),
      workflow,
      invocation: {},
      config: {},
      run: {
        run_id: runId,
        workflow_id: workflow.id,
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: stores.backends,
      builtIns: { "runtime.pre": executePre },
      agentRuntime: {} as AgentRuntimePort,
      onFailedState: failedState
    };

    const acceptanceUnknown = await runCompiledWorkflow(input).catch(
      (cause: unknown) => cause
    );
    expect(acceptanceUnknown).toMatchObject({
      code: "runtime_checkpoint_write_acceptance_unknown"
    });
    expect(executePre).toHaveBeenCalledTimes(1);

    stores.failNextWaitIntentRead();
    const transientRead = await runCompiledWorkflow(input).catch(
      (cause: unknown) => cause
    );

    expect(transientRead).toMatchObject({
      code: "runtime_durability_recovery_required",
      details: {
        operation: "load_interrupt_wait_intent",
        checkpoint_id: waitingCheckpointId
      }
    });
    expect(executePre).toHaveBeenCalledTimes(1);
    expect(failedState).not.toHaveBeenCalled();
    await expect(stores.durableCheckpoints.load(runId, {
      checkpointId: `terminal-${runId}-failed`,
      checkpointNs: ""
    })).resolves.toBeUndefined();
    expect((await stores.backends.events.list(runId)).filter(
      (event) => event.type === "run.failed" || event.type === "node.failed"
    )).toEqual([]);

    const recovered = await runCompiledWorkflow(input);

    expect(recovered).toMatchObject({
      status: "waiting_for_input",
      interrupt_id: `interrupt-${runId}-approve`,
      checkpoint_id: waitingCheckpointId,
      state: {
        run_status: "waiting_for_input",
        steps: { pre: { ready: true } }
      }
    });
    expect(executePre).toHaveBeenCalledTimes(1);
    expect(failedState).not.toHaveBeenCalled();
  });
});
