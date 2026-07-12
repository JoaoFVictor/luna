import type {
  ResumeWorkflowInput,
  RunWorkflowInput
} from "../../core/workflow/execution-contracts.js";
import { resumeInterrupt } from "../../core/runtime/interrupts/resume.js";
import {
  isCheckpointPlainObject,
  stableJson,
  type JsonObject,
  type JsonValue
} from "../../core/runtime/json.js";
import type {
  CheckpointRecord,
  CheckpointWriteRecord
} from "../../core/runtime/backends/contracts.js";
import {
  LUNA_RUNTIME_STATE_SCHEMA_VERSION,
  createInitialRuntimeState,
  publishNodeOutput,
  type LunaRuntimeState,
  type RuntimeArtifactRef,
  type RuntimeInterruptRef
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
import {
  listCheckpointWritesForRecovery,
  saveCheckpointWriteExactly
} from "./checkpoint-io.js";
import {
  saveNodeCompletionWrite,
  saveNodeOutputWrite
} from "./node-durability.js";
import { publishArtifactsForNode } from "./node-artifacts.js";
import {
  resumeContextFromMetadata
} from "./interrupts.js";
import {
  checkpointId as waitingCheckpointId
} from "./interrupt-wait-protocol.js";
import {
  assertNodeOutputMatchesSchema
} from "./node-runner.js";
import { loadPersistedWorkflowNodeRecovery } from "./persisted-node-recovery.js";
import { validateResumeWaitIntent } from "./resume-wait-intent-validation.js";
import {
  encodeRuntimeReference,
  mergeRuntimeReferences,
  parseRuntimeReference
} from "./runtime-reference-codec.js";
import {
  mergePrecompletedStepsWithRecovery,
  validatePrecompletedSteps
} from "./precompleted-steps.js";

const RESUME_COMPLETION_SCHEMA_VERSION = 1;
const RESUME_COMPLETION_CHANNEL = "resume_completion";

type DurableResumeCompletion = {
  readonly artifactRefs: LunaRuntimeState["artifact_refs"];
};

type ResumeWrites = {
  readonly resumeCheckpointWrites: readonly CheckpointWriteRecord[];
  readonly stepWrites: readonly CheckpointWriteRecord[];
  readonly completedNodeIds: ReadonlySet<string>;
  readonly outputPendingByNode: ReadonlyMap<string, JsonValue>;
  readonly completedArtifactRefs: LunaRuntimeState["artifact_refs"];
  readonly completedInterruptRefs: LunaRuntimeState["interrupt_refs"];
};

export type WorkflowResumeNodeRecovery = {
  readonly completedNodeIds: ReadonlySet<string>;
  readonly outputPendingByNode: ReadonlyMap<string, JsonValue>;
};

export type WorkflowResumeApplication<TInput extends ResumeWorkflowInput> = {
  readonly resumedInput: TInput & RunWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly startIndex: number;
  readonly nodeRecovery: WorkflowResumeNodeRecovery;
};

export type ValidatedResumeCheckpoint = {
  readonly checkpoint: CheckpointRecord;
  readonly resumeContext: ReturnType<typeof resumeContextFromMetadata>;
  readonly resumeIndex: number;
  readonly resumeNodeId: string;
};

/**
 * Validates the durable origin of a resume without changing checkpoints,
 * interrupts, or events. This must run before a legacy execution receives its
 * first workflow-identity checkpoint: an invalid resume request must never be
 * able to bind an old waiting run to the request's workflow revision.
 */
export async function preflightWorkflowResume<TInput extends ResumeWorkflowInput>(
  input: TInput
): Promise<ValidatedResumeCheckpoint> {
  const validated = await loadValidatedResumeCheckpoint(input);
  const interrupt = await input.backends.interrupts.get(input.interrupt_id);
  if (interrupt === undefined) {
    throw runtimeError("Interrupt not found", "runtime_interrupt_not_found", {
      details: { interrupt_id: input.interrupt_id }
    });
  }
  if (
    interrupt.id !== input.interrupt_id ||
    interrupt.run_id !== input.thread_id ||
    interrupt.thread_id !== input.thread_id ||
    interrupt.checkpoint_id !== input.checkpoint_id ||
    interrupt.node_id !== validated.resumeNodeId
  ) {
    throw runtimeError(
      "Interrupt resume does not match the durable waiting checkpoint",
      "interrupt_stale",
      {
        details: {
          interrupt_id: input.interrupt_id,
          checkpoint_id: input.checkpoint_id,
          thread_id: input.thread_id
        }
      }
    );
  }
  const laterInterrupt = (await input.backends.interrupts.list(input.thread_id))
    .find((candidate) => {
      if (candidate.id === interrupt.id) {
        return false;
      }
      const candidateIndex = input.compiled.nodes.findIndex(
        (node) => node.id === candidate.node_id
      );
      return candidateIndex > validated.resumeIndex;
    });
  if (laterInterrupt !== undefined) {
    throw runtimeError(
      "Interrupt resume is stale relative to a later gate",
      "interrupt_stale",
      {
        details: {
          interrupt_id: input.interrupt_id,
          later_interrupt_id: laterInterrupt.id
        }
      }
    );
  }
  await validateResumeWaitIntent({
    input,
    checkpoint: validated.checkpoint,
    resumeContext: validated.resumeContext,
    resumeNode: input.compiled.nodes[validated.resumeIndex],
    interrupt
  });
  return validated;
}

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
  assertNodeOutputMatchesSchema(resumeNode, input.decision);
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

async function loadValidatedResumeCheckpoint<
  TInput extends ResumeWorkflowInput
>(input: TInput): Promise<ValidatedResumeCheckpoint> {
  const checkpoint = await input.backends.checkpoints.load(input.thread_id, {
    checkpointId: input.checkpoint_id,
    expectedStateSchemaVersion: LUNA_RUNTIME_STATE_SCHEMA_VERSION
  });
  if (checkpoint === undefined) {
    throw runtimeError("Checkpoint not found", "runtime_interrupt_not_found", {
      details: { checkpoint_id: input.checkpoint_id, thread_id: input.thread_id }
    });
  }
  if (
    checkpoint.thread_id !== input.thread_id ||
    checkpoint.checkpoint_id !== input.checkpoint_id ||
    checkpoint.checkpoint_ns !== "" ||
    checkpoint.state.run_status !== "waiting_for_input"
  ) {
    throw runtimeError(
      "Resume checkpoint is not the exact waiting checkpoint requested",
      "runtime_checkpoint_schema_mismatch",
      {
        details: {
          checkpoint_id: input.checkpoint_id,
          thread_id: input.thread_id
        }
      }
    );
  }
  if (checkpoint.metadata.workflow_revision !== input.workflow.revision) {
    throw runtimeError(
      "Checkpoint workflow revision is incompatible",
      "runtime_checkpoint_schema_mismatch",
      {
        details: {
          expected: input.workflow.revision,
          actual: checkpoint.metadata.workflow_revision
        }
      }
    );
  }
  if (checkpoint.state_schema_version !== input.compiled.state_schema_version) {
    throw runtimeError(
      "Checkpoint state schema is incompatible with compiled workflow",
      "runtime_checkpoint_schema_mismatch",
      {
        details: {
          expected: input.compiled.state_schema_version,
          actual: checkpoint.state_schema_version
        }
      }
    );
  }

  const resumeNodeId = String(checkpoint.metadata.resume_node_id ?? "");
  const resumeIndex = input.compiled.nodes.findIndex(
    (node) => node.id === resumeNodeId
  );
  if (resumeIndex < 0) {
    throw runtimeError("Resume node is not part of compiled workflow", "runtime_state_invalid", {
      details: { resume_node_id: resumeNodeId }
    });
  }

  const resumeContext = resumeContextFromMetadata(checkpoint.metadata);
  if (
    resumeContext.run.run_id !== input.thread_id ||
    resumeContext.run.workflow_id !== input.workflow.id ||
    input.checkpoint_id !== waitingCheckpointId(input.thread_id, resumeNodeId)
  ) {
    throw runtimeError(
      "Checkpoint resume context conflicts with its execution identity",
      "runtime_checkpoint_schema_mismatch",
      {
        details: {
          checkpoint_id: input.checkpoint_id,
          thread_id: input.thread_id,
          workflow_id: input.workflow.id
        }
      }
    );
  }

  return {
    checkpoint,
    resumeContext,
    resumeIndex,
    resumeNodeId
  };
}

function resumedInputFromContext<TInput extends ResumeWorkflowInput>(
  input: TInput,
  resumeContext: ReturnType<typeof resumeContextFromMetadata>
): TInput & RunWorkflowInput {
  return {
    ...input,
    run: resumeContext.run,
    invocation: resumeContext.invocation,
    config: resumeContext.config,
    ...(resumeContext.precompleted_steps === undefined
      ? {}
      : { precompleted_steps: resumeContext.precompleted_steps })
  };
}

async function loadResumeWrites<TInput extends ResumeWorkflowInput>({
  input,
  resumeContext,
  checkpointNs,
  checkpointId
}: {
  readonly input: TInput;
  readonly resumeContext: ReturnType<typeof resumeContextFromMetadata>;
  readonly checkpointNs: string;
  readonly checkpointId: string;
}): Promise<ResumeWrites> {
  const resumeCheckpointWrites = await listCheckpointWritesForRecovery({
    input,
    threadId: input.thread_id,
    checkpointNs,
    checkpointId,
    operation: "load_resume_checkpoint_writes"
  });
  const recovered = await loadPersistedWorkflowNodeRecovery(
    input,
    resumeContext.run.run_id
  );

  return {
    resumeCheckpointWrites,
    stepWrites: [
      ...resumeCheckpointWrites,
      ...recovered.stepWrites
    ].filter((write) => write.channel === "steps"),
    completedNodeIds: recovered.completedNodeIds,
    outputPendingByNode: recovered.outputPendingByNode,
    completedArtifactRefs: recovered.completedArtifactRefs,
    completedInterruptRefs: recovered.completedInterruptRefs
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

function nextDecisionWriteIndex(
  writes: readonly CheckpointWriteRecord[],
  resumeNodeId: string
): number {
  return writes
    .filter((write) => write.task_id === resumeNodeId)
    .reduce((nextIndex, write) => Math.max(nextIndex, write.index + 1), 0);
}

function resumeCompletionTaskId(resumeNodeId: string): string {
  return `__luna_resume_completion__:${resumeNodeId}`;
}

function resumeCompletionMarker(
  decision: JsonValue,
  artifactRefs: LunaRuntimeState["artifact_refs"]
): JsonObject {
  return {
    schema_version: RESUME_COMPLETION_SCHEMA_VERSION,
    decision,
    artifact_refs: artifactRefs.map(encodeRuntimeReference)
  };
}

function resumeCompletionFromWrites({
  writes,
  resumeNodeId,
  decision,
  interruptId
}: {
  readonly writes: readonly CheckpointWriteRecord[];
  readonly resumeNodeId: string;
  readonly decision: JsonValue;
  readonly interruptId: string;
}): DurableResumeCompletion | undefined {
  const markers = writes.filter(
    (write) =>
      write.task_id === resumeCompletionTaskId(resumeNodeId) &&
      write.channel === RESUME_COMPLETION_CHANNEL
  );
  if (markers.length === 0) {
    return undefined;
  }
  if (markers.length !== 1 || markers[0]?.index !== 0) {
    throw runtimeError(
      "Checkpoint contains ambiguous resume completion markers",
      "runtime_state_invalid",
      { details: { node_id: resumeNodeId } }
    );
  }

  const marker = markers[0].value;
  if (
    !isCheckpointPlainObject(marker) ||
    marker.schema_version !== RESUME_COMPLETION_SCHEMA_VERSION ||
    !Object.prototype.hasOwnProperty.call(marker, "decision") ||
    Object.keys(marker).some(
      (key) => !["schema_version", "decision", "artifact_refs"].includes(key)
    ) ||
    !Array.isArray(marker.artifact_refs)
  ) {
    throw runtimeError(
      "Checkpoint contains an invalid resume completion marker",
      "runtime_state_invalid",
      { details: { node_id: resumeNodeId } }
    );
  }
  if (stableJson(marker.decision as JsonValue) !== stableJson(decision)) {
    throw runtimeError(
      "Checkpoint resume completion conflicts with the requested decision",
      "interrupt_conflict",
      { details: { interrupt_id: interruptId, node_id: resumeNodeId } }
    );
  }

  return {
    artifactRefs: marker.artifact_refs.map((artifact, index) =>
      parseResumeArtifactRef(artifact, resumeNodeId, index)
    )
  };
}

function parseResumeArtifactRef(
  value: JsonValue,
  resumeNodeId: string,
  index: number
): LunaRuntimeState["artifact_refs"][number] {
  return parseRuntimeReference<RuntimeArtifactRef>(value, () => runtimeError(
      "Checkpoint resume completion contains an invalid artifact reference",
      "runtime_state_invalid",
      { details: { node_id: resumeNodeId, artifact_index: index } }
    ));
}

function checkpointArtifactRefs(
  value: JsonValue | undefined
): LunaRuntimeState["artifact_refs"] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw runtimeError(
      "Waiting checkpoint contains invalid artifact references",
      "runtime_state_invalid"
    );
  }
  return value.map((artifact, index) =>
    parseRuntimeReference<RuntimeArtifactRef>(artifact, () => runtimeError(
      "Waiting checkpoint contains an invalid artifact reference",
      "runtime_state_invalid",
      { details: { artifact_index: index } }
    ))
  );
}

function checkpointInterruptRefs(
  value: JsonValue | undefined
): LunaRuntimeState["interrupt_refs"] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw runtimeError(
      "Waiting checkpoint contains invalid interrupt references",
      "runtime_state_invalid"
    );
  }
  return value.map((ref, index) =>
    parseRuntimeReference<RuntimeInterruptRef>(ref, () => runtimeError(
      "Waiting checkpoint contains an invalid interrupt reference",
      "runtime_state_invalid",
      { details: { interrupt_index: index } }
    ))
  );
}

function requiredResumeInterruptRef(
  refs: LunaRuntimeState["interrupt_refs"],
  interruptId: string,
  nodeId: string
): LunaRuntimeState["interrupt_refs"][number] {
  const matches = refs.filter(
    (ref) => ref.id === interruptId && ref.node_id === nodeId
  );
  if (matches.length !== 1) {
    throw runtimeError(
      "Waiting checkpoint does not contain the exact resumed interrupt reference",
      "runtime_state_invalid",
      { details: { interrupt_id: interruptId, node_id: nodeId } }
    );
  }
  return matches[0];
}
