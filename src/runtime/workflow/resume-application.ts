import type {
  ResumeWorkflowInput,
  RunWorkflowInput
} from "../../core/workflow/execution-contracts.js";
import { resumeInterrupt } from "../../core/runtime/interrupts/resume.js";
import {
  stableJson,
  type JsonValue
} from "../../core/runtime/json.js";
import type { CheckpointWriteRecord } from "../../core/runtime/backends/contracts.js";
import {
  createInitialRuntimeState,
  publishNodeOutput,
  type LunaRuntimeState
} from "../../core/runtime/state.js";
import {
  startNodeAttempt,
  succeedNode
} from "../../core/runtime/lifecycle.js";
import { runtimeError } from "../../core/runtime/errors.js";
import type {
  CompiledWorkflowNode
} from "../../core/workflow/compiler.js";
import { appendWorkflowEvent } from "../../core/workflow/events.js";
import { saveCheckpointWriteExactly } from "./checkpoint-io.js";
import {
  saveNodeCompletionWrite,
  saveNodeOutputWrite
} from "./node-durability.js";
import { publishArtifactsForNode } from "./node-artifacts.js";
import {
  assertNodeOutputMatchesSchema
} from "./node-runner.js";
import { mergeRuntimeReferences } from "./runtime-reference-codec.js";
import {
  mergePrecompletedStepsWithRecovery,
  validatePrecompletedSteps
} from "./precompleted-steps.js";
import {
  loadValidatedResumeCheckpoint,
  resumedInputFromContext,
  type ValidatedResumeCheckpoint
} from "./resume-origin.js";
import {
  checkpointArtifactRefs,
  checkpointInterruptRefs,
  loadResumeWrites,
  nextDecisionWriteIndex,
  requiredResumeInterruptRef,
  RESUME_COMPLETION_CHANNEL,
  resumeCompletionFromWrites,
  resumeCompletionMarker,
  resumeCompletionTaskId,
  type DurableResumeCompletion
} from "./resume-recovery-codec.js";
import type { PersistedPendingNodeOutput } from "./persisted-node-recovery.js";

export {
  preflightWorkflowResume
} from "./resume-origin.js";
export type { ValidatedResumeCheckpoint } from "./resume-origin.js";

export type WorkflowResumeNodeRecovery = {
  readonly completedNodeIds: ReadonlySet<string>;
  readonly outputPendingByNode: ReadonlyMap<string, PersistedPendingNodeOutput>;
};

export type WorkflowResumeApplication<TInput extends ResumeWorkflowInput> = {
  readonly resumedInput: TInput & RunWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly startIndex: number;
  readonly nodeRecovery: WorkflowResumeNodeRecovery;
};

export async function applyWorkflowResume<TInput extends ResumeWorkflowInput>(
  input: TInput,
  validatedCheckpoint?: ValidatedResumeCheckpoint
): Promise<WorkflowResumeApplication<TInput>> {
  const {
    checkpoint,
    resumeContext,
    resumeIndex,
    resumeNodeId
  } = validatedCheckpoint ?? await loadValidatedResumeCheckpoint(input);
  let state = createInitialRuntimeState({
    invocation: resumeContext.invocation,
    config: resumeContext.config,
    run: resumeContext.run,
    workflow: { id: input.workflow.id, mode: input.workflow.mode }
  });
  const priorWrites = await loadResumeWrites({
    input,
    resumeContext,
    checkpointNs: checkpoint.checkpoint_ns,
    checkpointId: input.checkpoint_id
  });
  state = {
    ...state,
    artifact_refs: mergeRuntimeReferences(
      checkpointArtifactRefs(checkpoint.state.artifact_refs),
      priorWrites.completedArtifactRefs
    ),
    interrupt_refs: mergeRuntimeReferences(
      checkpointInterruptRefs(checkpoint.state.interrupt_refs),
      priorWrites.completedInterruptRefs
    ),
    steps: mergePrecompletedStepsWithRecovery(
      validatePrecompletedSteps(input.compiled, resumeContext.precompleted_steps),
      Object.fromEntries(
        priorWrites.stepWrites.map((write) => [write.task_id, write.value])
      )
    )
  };

  const resumeNode = input.compiled.nodes[resumeIndex];
  const decisionNode = resumeNode.kind === "loop"
    ? resumeNode.loop_body.at(-1)
    : resumeNode;
  if (decisionNode === undefined || decisionNode.kind !== "interrupt") {
    throw runtimeError(
      "Resume node does not expose a compiled interrupt decision contract",
      "runtime_state_invalid",
      { details: { node_id: resumeNode.id } }
    );
  }
  assertNodeOutputMatchesSchema(decisionNode, input.decision);
  const decisionAlreadyApplied = Object.prototype.hasOwnProperty.call(
    state.steps,
    resumeNodeId
  );
  if (
    decisionAlreadyApplied &&
    stableJson(state.steps[resumeNodeId]) !== stableJson(input.decision)
  ) {
    throw runtimeError(
      "Checkpoint resume decision conflicts with an already-applied decision",
      "interrupt_conflict",
      { details: { interrupt_id: input.interrupt_id, node_id: resumeNodeId } }
    );
  }
  const durableCompletion = resumeCompletionFromWrites({
    writes: priorWrites.resumeCheckpointWrites,
    resumeNodeId,
    decision: input.decision,
    interruptId: input.interrupt_id
  });
  if (durableCompletion !== undefined && !decisionAlreadyApplied) {
    throw runtimeError(
      "Checkpoint resume completion exists without its decision write",
      "runtime_state_invalid",
      {
        details: {
          checkpoint_id: input.checkpoint_id,
          node_id: resumeNodeId
        }
      }
    );
  }

  await resumeInterrupt(
    {
      interrupt_id: input.interrupt_id,
      thread_id: input.thread_id,
      checkpoint_id: input.checkpoint_id,
      decision: input.decision
    },
    {
      interruptStore: input.backends.interrupts,
      eventStore: input.backends.events,
      resumeId: () => `resume-${input.interrupt_id}`
    }
  );
  try {
    await input.observability?.recorder.addEvent("interrupt.resumed", {
      interrupt_id: input.interrupt_id,
      checkpoint_id: input.checkpoint_id,
      node_id: resumeNodeId
    });
  } catch {
    // The resolved interrupt is authoritative. Telemetry cannot prevent the
    // already-authorized decision from being applied to the checkpoint.
  }

  const resumedInput = resumedInputFromContext(input, resumeContext);
  if (resumeNode.kind === "loop") {
    const continuation = resumeContext.loop_continuation;
    if (continuation === undefined || continuation.node_id !== resumeNode.id) {
      throw runtimeError("Loop resume checkpoint is missing its continuation", "runtime_checkpoint_schema_mismatch", {
        details: { node_id: resumeNode.id }
      });
    }
    return {
      resumedInput: {
        ...resumedInput,
        loop_resume: {
          ...continuation,
          decision: input.decision
        }
      },
      state,
      startIndex: resumeIndex,
      nodeRecovery: {
        completedNodeIds: priorWrites.completedNodeIds,
        outputPendingByNode: priorWrites.outputPendingByNode
      }
    };
  }
  const decisionApplication = await applyResumeDecision({
    input: resumedInput,
    state,
    resumeNode,
    decisionAlreadyApplied,
    durableCompletion,
    decision: input.decision,
    checkpointNs: checkpoint.checkpoint_ns,
    checkpointId: input.checkpoint_id,
    resumeCheckpointWrites: priorWrites.resumeCheckpointWrites,
    interruptRef: requiredResumeInterruptRef(
      state.interrupt_refs,
      input.interrupt_id,
      resumeNodeId
    )
  });
  state = decisionApplication.state;

  const startIndex = resumeIndex + 1;
  if (!decisionApplication.completionDurable) {
    throw runtimeError(
      "Resume decision returned without a durable completion marker",
      "runtime_state_invalid",
      { details: { node_id: resumeNodeId } }
    );
  }

  return {
    resumedInput,
    state,
    startIndex,
    nodeRecovery: {
      completedNodeIds: priorWrites.completedNodeIds,
      outputPendingByNode: priorWrites.outputPendingByNode
    }
  };
}

async function applyResumeDecision<TInput extends RunWorkflowInput & ResumeWorkflowInput>({
  input,
  state,
  resumeNode,
  decisionAlreadyApplied,
  durableCompletion,
  decision,
  checkpointNs,
  checkpointId,
  resumeCheckpointWrites,
  interruptRef
}: {
  readonly input: TInput;
  readonly state: LunaRuntimeState;
  readonly resumeNode: CompiledWorkflowNode;
  readonly decisionAlreadyApplied: boolean;
  readonly durableCompletion: DurableResumeCompletion | undefined;
  readonly decision: JsonValue;
  readonly checkpointNs: string;
  readonly checkpointId: string;
  readonly resumeCheckpointWrites: readonly CheckpointWriteRecord[];
  readonly interruptRef: LunaRuntimeState["interrupt_refs"][number];
}): Promise<{
  readonly state: LunaRuntimeState;
  readonly completionDurable: boolean;
}> {
  let nextState = startNodeAttempt(state, resumeNode.id, 1);
  if (!decisionAlreadyApplied) {
    await saveCheckpointWriteExactly(input, {
      thread_id: input.thread_id,
      checkpoint_ns: checkpointNs,
      checkpoint_id: checkpointId,
      task_id: resumeNode.id,
      index: nextDecisionWriteIndex(resumeCheckpointWrites, resumeNode.id),
      channel: "steps",
      value: decision
    });
  }

  let completion = durableCompletion;
  if (completion === undefined) {
    await saveNodeOutputWrite({
      input,
      node: resumeNode,
      output: decision
    });
    if (!decisionAlreadyApplied) {
      nextState = publishNodeOutput(nextState, resumeNode.id, decision);
    }
    const artifactRefs = await publishArtifactsForNode(
      input,
      resumeNode,
      decision,
      nextState
    );
    const marker = resumeCompletionMarker(decision, artifactRefs);
    await saveCheckpointWriteExactly(input, {
      thread_id: input.thread_id,
      checkpoint_ns: checkpointNs,
      checkpoint_id: checkpointId,
      task_id: resumeCompletionTaskId(resumeNode.id),
      index: 0,
      channel: RESUME_COMPLETION_CHANNEL,
      value: marker
    });
    completion = { artifactRefs };
  }

  await saveNodeCompletionWrite({
    input,
    node: resumeNode,
    output: decision,
    artifactRefs: completion.artifactRefs,
    interruptRefs: [interruptRef]
  });

  if (completion.artifactRefs.length > 0) {
    nextState = {
      ...nextState,
      artifact_refs: mergeRuntimeReferences(
        nextState.artifact_refs,
        completion.artifactRefs
      )
    };
  }

  nextState = succeedNode(nextState, resumeNode.id);
  if (durableCompletion === undefined) {
    await appendWorkflowEvent(
      input,
      "node.succeeded",
      resumeNode.id
    ).catch(() => {
      // The durable completion marker is authoritative. Telemetry emitted
      // afterward must not turn a completed resume back into a retry.
    });
  }

  return { state: nextState, completionDurable: true };
}
