import type { CheckpointRecord } from "../../core/runtime/backends/contracts.js";
import type { InterruptRecord } from "../../core/runtime/interrupts/contracts.js";
import {
  isCheckpointPlainObject,
  stableJson,
  type JsonObject,
  type JsonValue
} from "../../core/runtime/json.js";
import type { RunHandle } from "../../core/runtime/run-handle.js";
import type {
  RuntimeArtifactRef,
  RuntimeInterruptRef
} from "../../core/runtime/state.js";
import { runtimeError } from "../../core/runtime/errors.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type {
  RunWorkflowInput,
  ResumeWorkflowInput,
  WorkflowPrecompletedSteps
} from "../../core/workflow/execution-contracts.js";
import { listCheckpointWritesForRecovery } from "./checkpoint-io.js";
import {
  interruptIdMatches as waitingInterruptIdMatches,
  parseInterruptWaitIntent,
  waitIntentTaskId,
  WAIT_INTENT_CHANNEL
} from "./interrupt-wait-protocol.js";
import {
  mergeRuntimeReferences,
  parseRuntimeReference,
  runtimeReferenceCollectionsEqual
} from "./runtime-reference-codec.js";

type ResumeContext = {
  readonly invocation: JsonValue;
  readonly config: JsonValue;
  readonly run: RunHandle;
  readonly precompleted_steps?: WorkflowPrecompletedSteps;
  readonly loop_continuation?: RunWorkflowInput["loop_continuation"];
};

export async function validateResumeWaitIntent({
  input,
  checkpoint,
  resumeContext,
  resumeNode,
  interrupt
}: {
  readonly input: ResumeWorkflowInput;
  readonly checkpoint: CheckpointRecord;
  readonly resumeContext: ResumeContext;
  readonly resumeNode: CompiledWorkflowNode;
  readonly interrupt: InterruptRecord;
}): Promise<void> {
  if (resumeNode.kind !== "interrupt" && resumeNode.kind !== "loop") {
    throw invalidResumeWaitIntent(input, "resume_node_not_interrupt");
  }
  const occurrence = resumeNode.kind === "loop"
    ? loopOccurrence(input, resumeContext, resumeNode)
    : undefined;
  const expectedCapabilityId = resumeNode.kind === "loop"
    ? loopGateCapability(input, resumeNode)
    : resumeNode.capability_id;
  const writes = await listCheckpointWritesForRecovery({
    input,
    threadId: input.thread_id,
    checkpointNs: checkpoint.checkpoint_ns,
    checkpointId: input.checkpoint_id,
    operation: "validate_interrupt_wait_intent"
  });
  const taskId = waitIntentTaskId(resumeNode.id);
  const intentWrites = writes.filter(
    (write) => write.task_id === taskId || write.channel === WAIT_INTENT_CHANNEL
  );
  if (
    intentWrites.length !== 1 ||
    intentWrites[0]?.task_id !== taskId ||
    intentWrites[0].channel !== WAIT_INTENT_CHANNEL ||
    intentWrites[0].index !== 0 ||
    intentWrites[0].thread_id !== input.thread_id ||
    intentWrites[0].checkpoint_ns !== checkpoint.checkpoint_ns ||
    intentWrites[0].checkpoint_id !== input.checkpoint_id
  ) {
    throw invalidResumeWaitIntent(input, "wait_intent_missing_or_ambiguous");
  }
  const intent = parseInterruptWaitIntent(
    intentWrites[0].value,
    (details) => invalidResumeWaitIntent(input, "wait_intent_invalid", details)
  );
  const metadataContext = checkpoint.metadata.resume_context;
  if (!isCheckpointPlainObject(metadataContext)) {
    throw invalidResumeWaitIntent(input, "resume_context_missing");
  }
  const expectedContext: JsonObject = {
    invocation: resumeContext.invocation,
    config: resumeContext.config,
    run: resumeContext.run,
    ...(resumeContext.precompleted_steps === undefined
      ? {}
      : { precompleted_steps: resumeContext.precompleted_steps }),
    ...(resumeContext.loop_continuation === undefined
      ? {}
      : { loop_continuation: resumeContext.loop_continuation })
  };
  const checkpointArtifactReferences = parseArtifactReferences(
    checkpoint.state.artifact_refs,
    input
  );
  const checkpointInterruptReferences = parseInterruptReferences(
    checkpoint.state.interrupt_refs,
    input
  );
  const expectedInterruptReferences = mergeRuntimeReferences(
    intent.interrupt_refs,
    [{
      id: intent.interrupt_id,
      uri: `interrupt://${input.thread_id}/${resumeNode.id}${
        occurrence === undefined ? "" : `/${occurrence}`
      }`,
      node_id: resumeNode.id
    }]
  );
  const payload = interrupt.payload;
  if (
    intent.run_id !== input.thread_id ||
    intent.workflow_revision !== input.workflow.revision ||
    intent.node_id !== resumeNode.id ||
    intent.capability_id !== expectedCapabilityId ||
    intent.checkpoint_id !== input.checkpoint_id ||
    intent.interrupt_id !== input.interrupt_id ||
    !waitingInterruptIdMatches(
      intent.interrupt_id,
      input.thread_id,
      resumeNode.id,
      occurrence
    ) ||
    intent.created_at !== checkpoint.created_at ||
    intent.created_at !== checkpoint.checkpoint.ts ||
    intent.created_at !== interrupt.created_at ||
    !runtimeReferenceCollectionsEqual(
      intent.artifact_refs,
      checkpointArtifactReferences
    ) ||
    !runtimeReferenceCollectionsEqual(
      expectedInterruptReferences,
      checkpointInterruptReferences
    ) ||
    Object.keys(intent.resume_context).sort().join("\u0000") !==
      Object.keys(expectedContext).sort().join("\u0000") ||
    stableJson(intent.resume_context) !== stableJson(metadataContext) ||
    stableJson(intent.resume_context) !== stableJson(expectedContext) ||
    (payload !== undefined &&
      (payload.interrupt_id !== intent.interrupt_id ||
        payload.checkpoint_id !== intent.checkpoint_id ||
        payload.node_id !== intent.node_id ||
        payload.kind !== intent.capability_id ||
        payload.created_at !== intent.created_at ||
        stableJson(payload.run) !== stableJson(resumeContext.run)))
  ) {
    throw invalidResumeWaitIntent(input, "wait_intent_conflict");
  }
}

function loopOccurrence(
  input: ResumeWorkflowInput,
  context: ResumeContext,
  node: CompiledWorkflowNode
): string {
  const continuation = context.loop_continuation;
  if (
    continuation === undefined ||
    continuation.node_id !== node.id ||
    !Number.isSafeInteger(continuation.iteration) ||
    continuation.iteration < 1
  ) {
    throw invalidResumeWaitIntent(input, "loop_continuation_invalid");
  }
  return `iteration-${continuation.iteration}`;
}

function loopGateCapability(
  input: ResumeWorkflowInput,
  node: CompiledWorkflowNode
): string {
  const gate = node.loop_body?.at(-1);
  if (gate?.kind !== "interrupt") {
    throw invalidResumeWaitIntent(input, "loop_gate_invalid");
  }
  return gate.capability_id;
}

function parseArtifactReferences(
  value: JsonValue | undefined,
  input: ResumeWorkflowInput
): RuntimeArtifactRef[] {
  if (!Array.isArray(value)) {
    throw invalidResumeWaitIntent(input, "artifact_refs_invalid");
  }
  return value.map((reference, index) =>
    parseRuntimeReference<RuntimeArtifactRef>(reference, () =>
      invalidResumeWaitIntent(input, "artifact_ref_invalid", {
        artifact_index: index
      })
    )
  );
}

function parseInterruptReferences(
  value: JsonValue | undefined,
  input: ResumeWorkflowInput
): RuntimeInterruptRef[] {
  if (!Array.isArray(value)) {
    throw invalidResumeWaitIntent(input, "interrupt_refs_invalid");
  }
  return value.map((reference, index) =>
    parseRuntimeReference<RuntimeInterruptRef>(reference, () =>
      invalidResumeWaitIntent(input, "interrupt_ref_invalid", {
        interrupt_index: index
      })
    )
  );
}

function invalidResumeWaitIntent(
  input: Pick<ResumeWorkflowInput, "thread_id" | "checkpoint_id" | "interrupt_id">,
  reason: string,
  details: Record<string, unknown> = {}
): Error {
  return runtimeError(
    "Interrupt wait intent does not exactly authorize this legacy resume",
    "runtime_checkpoint_schema_mismatch",
    {
      details: {
        reason,
        thread_id: input.thread_id,
        checkpoint_id: input.checkpoint_id,
        interrupt_id: input.interrupt_id,
        ...details
      }
    }
  );
}
