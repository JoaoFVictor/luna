import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import type {
  CheckpointStore,
  RuntimeBackends
} from "../../../src/core/runtime/backends/contracts.js";
import type { InterruptStore } from "../../../src/core/runtime/interrupts/contracts.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import { runCompiledWorkflow } from "../../../src/runtime/langgraph/workflow-runner.js";
import { recoverNativeWorkflowWaitingTarget } from "../../../src/platform/native/native-workflow-runner.js";
import {
  recoverPersistedWaitingBoundaryByIdentity,
  waitingBoundaryNodeIdentity
} from "../../../src/runtime/workflow/resume-origin.js";
import { loadYamlFile } from "../../../src/core/config/loader.js";
import { AppConfigSchema } from "../../../src/core/config/schemas.js";
import { runtimeCompositionConfig } from "../../../src/platform/native/native-run-context.js";
import { createRuntimeBackendComposition } from "../../../src/runtime/composition/runtime-composition.js";
import {
  cleanupNativeLaunchFixtures,
  writeFixture
} from "../../studio/runs/native-run-launch-test-support.js";
import {
  createFaultedWaitBackends,
  interruptWaitRecoveryRegistry,
  interruptWaitRecoveryWorkflow,
  WAIT_INTENT_CHANNEL
} from "./interrupt-wait-recovery-test-support.js";

const registry = interruptWaitRecoveryRegistry;
const workflow = interruptWaitRecoveryWorkflow;

afterEach(async () => {
  await cleanupNativeLaunchFixtures();
});

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
        expect.objectContaining({ channel: WAIT_INTENT_CHANNEL })
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

  it("reprojects an exact durable wait from storage without loading a capability catalog", async () => {
    const fixture = await writeFixture();
    const app = await loadYamlFile(fixture.configRoot + "/app.yaml", AppConfigSchema);
    const composition = createRuntimeBackendComposition(
      runtimeCompositionConfig(app, fixture.projectRoot)
    );
    const compiled = compileWorkflow({ workflow, registry });
    const runId = "run-native-waiting-reconciler";
    const run = {
      run_id: runId,
      workflow_id: workflow.id,
      attempt: 1,
      started_at: "2026-06-25T00:00:00.000Z"
    };
    const waiting = await runCompiledWorkflow({
      compiled,
      workflow,
      invocation: {},
      config: {},
      run,
      backends: composition.backends,
      builtIns: { "runtime.pre": async () => ({ ready: true }) },
      agentRuntime: {} as AgentRuntimePort
    });
    if (waiting.status !== "waiting_for_input") {
      throw new Error("Expected a durable waiting boundary");
    }
    const recoveryInput = {
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      workflow: {
        id: workflow.id,
        revision: workflow.revision,
        mode: workflow.mode,
        state_schema_version: compiled.state_schema_version,
        nodes: compiled.nodes.map(waitingBoundaryNodeIdentity)
      },
      thread_id: runId,
      checkpoint_id: waiting.checkpoint_id,
      interrupt_id: waiting.interrupt_id
    } as const;
    const onWaitingState = vi.fn();

    await expect(recoverNativeWorkflowWaitingTarget({
      ...recoveryInput,
      onWaitingState
    })).resolves.toMatchObject({
      status: "waiting_for_input",
      checkpoint_id: waiting.checkpoint_id,
      interrupt_id: waiting.interrupt_id,
      state: {
        run_status: "waiting_for_input",
        steps: { pre: { ready: true } },
        node_statuses: {
          approve: { status: "waiting_for_input" }
        },
        artifact_refs: [],
        interrupt_refs: [
          expect.objectContaining({ id: waiting.interrupt_id })
        ]
      }
    });
    expect(onWaitingState).toHaveBeenCalledTimes(1);

    for (const corruption of [
      "missing_intent",
      "conflicting_intent",
      "missing_interrupt_ref",
      "missing_interrupt_payload"
    ] as const) {
      await expect(recoverPersistedWaitingBoundaryByIdentity({
        workflow: recoveryInput.workflow,
        backends: corruptWaitingBoundary(
          composition.backends,
          waiting.checkpoint_id,
          corruption
        ),
        thread_id: runId,
        checkpoint_id: waiting.checkpoint_id,
        interrupt_id: waiting.interrupt_id
      })).rejects.toMatchObject({
        code: "runtime_checkpoint_schema_mismatch"
      });
    }

    await expect(recoverNativeWorkflowWaitingTarget({
      ...recoveryInput,
      checkpoint_id: "checkpoint-does-not-exist"
    })).rejects.toMatchObject({ code: "runtime_checkpoint_schema_mismatch" });

    const originalInterrupt = await composition.backends.interrupts.get(
      waiting.interrupt_id
    );
    if (originalInterrupt === undefined) throw new Error("Missing durable interrupt");
    const secondInterruptId = `${waiting.interrupt_id}-later`;
    await composition.backends.interrupts.create({
      ...originalInterrupt,
      id: secondInterruptId,
      created_at: "2026-06-25T00:01:00.000Z",
      updated_at: "2026-06-25T00:01:00.000Z",
      payload: originalInterrupt.payload === undefined ? undefined : {
        ...originalInterrupt.payload,
        interrupt_id: secondInterruptId,
        created_at: "2026-06-25T00:01:00.000Z"
      }
    });
    await expect(recoverNativeWorkflowWaitingTarget(recoveryInput))
      .rejects.toMatchObject({ code: "interrupt_stale" });

    for (const interruptId of [secondInterruptId, waiting.interrupt_id]) {
      const record = await composition.backends.interrupts.get(interruptId);
      if (record?.checkpoint_id === undefined) throw new Error("Missing interrupt checkpoint");
      const decision = { action: "reject" };
      const resumeInput = {
        interrupt_id: interruptId,
        thread_id: runId,
        checkpoint_id: record.checkpoint_id,
        decision
      };
      const claim = await composition.backends.interrupts.beginResume(
        interruptId,
        `resolve-${interruptId}`,
        resumeInput
      );
      if (claim.status !== "claimed") throw new Error("Expected interrupt claim");
      await composition.backends.interrupts.completeResume(
        interruptId,
        claim,
        "resolved",
        {
          interrupt_id: interruptId,
          resume_id: claim.resume_attempt,
          input: resumeInput,
          decision,
          created_at: "2026-06-25T00:02:00.000Z"
        }
      );
    }
    await expect(recoverNativeWorkflowWaitingTarget(recoveryInput))
      .rejects.toMatchObject({ code: "interrupt_stale" });
  });
});

function corruptWaitingBoundary(
  backends: RuntimeBackends,
  waitingCheckpointId: string,
  corruption:
    | "missing_intent"
    | "conflicting_intent"
    | "missing_interrupt_ref"
    | "missing_interrupt_payload"
): RuntimeBackends {
  const checkpoints: CheckpointStore = {
    ...backends.checkpoints,
    async load(threadId, options) {
      const checkpoint = await backends.checkpoints.load(threadId, options);
      if (
        checkpoint === undefined ||
        checkpoint.checkpoint_id !== waitingCheckpointId ||
        corruption !== "missing_interrupt_ref"
      ) {
        return checkpoint;
      }
      return {
        ...checkpoint,
        state: { ...checkpoint.state, interrupt_refs: [] }
      };
    },
    async listWrites(threadId, checkpointNs, checkpointId) {
      const writes = await backends.checkpoints.listWrites(
        threadId,
        checkpointNs,
        checkpointId
      );
      if (checkpointId !== waitingCheckpointId) return writes;
      if (corruption === "missing_intent") {
        return writes.filter(({ channel }) => channel !== WAIT_INTENT_CHANNEL);
      }
      if (corruption === "conflicting_intent") {
        const intent = writes.find(({ channel }) => channel === WAIT_INTENT_CHANNEL);
        return intent === undefined
          ? writes
          : [...writes, { ...intent, index: intent.index + 1 }];
      }
      return writes;
    }
  };
  const interrupts: InterruptStore = {
    ...backends.interrupts,
    async get(interruptId) {
      const interrupt = await backends.interrupts.get(interruptId);
      if (interrupt === undefined || corruption !== "missing_interrupt_payload") {
        return interrupt;
      }
      const { payload: _payload, ...withoutPayload } = interrupt;
      return withoutPayload;
    }
  };
  return { ...backends, checkpoints, interrupts };
}
