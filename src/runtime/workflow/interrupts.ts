import {
  assertCheckpointJsonObject,
  assertCheckpointJsonValue,
  isCheckpointPlainObject,
  stableJson,
  type JsonObject,
  type JsonValue
} from "../../core/runtime/json.js";
import type { RunHandle } from "../../core/runtime/run-handle.js";
import {
  LUNA_RUNTIME_STATE_SCHEMA_VERSION,
  type LunaRuntimeState
} from "../../core/runtime/state.js";
import { markNodeWaitingForInput } from "../../core/runtime/lifecycle.js";
import { createInterrupt } from "../../core/runtime/interrupts/resume.js";
import {
  isRuntimeDurabilityRecoveryRequired,
  RuntimeDurabilityRecoveryRequiredError,
  runtimeError
} from "../../core/runtime/errors.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";
import type { SaveCheckpointInput } from "../../core/runtime/backends/contracts.js";
import type { InterruptReview } from "../../core/runtime/interrupts/contracts.js";
import {
  listCheckpointWritesForRecovery,
  saveCheckpointExactly,
  saveCheckpointWriteExactly
} from "./checkpoint-io.js";
import {
  checkpointId,
  checkpointIdCandidates,
  interruptId,
  interruptIdMatches,
  parseInterruptWaitIntent,
  waitCompletionWrite,
  waitIntentTaskId,
  waitIntentWrite,
  WAIT_INTENT_CHANNEL,
  WAIT_INTENT_SCHEMA_VERSION,
  type InterruptWaitIntent
} from "./interrupt-wait-protocol.js";
import {
  mergeRuntimeReferences,
  runtimeReferenceCollectionsEqual
} from "./runtime-reference-codec.js";

export { checkpointId, interruptId };

export async function waitForHumanInput(
  input: RunWorkflowInput,
  state: LunaRuntimeState,
  node: CompiledWorkflowNode,
  reviewInput?: JsonValue,
  options: { readonly occurrence?: string } = {}
): Promise<LunaRuntimeState> {
  const waiting = markNodeWaitingForInput(state, node.id);
  const intent = await loadOrCreateWaitIntent(input, state, node, options.occurrence);
  const id = intent.interrupt_id;
  const checkpoint_id = intent.checkpoint_id;
  const waitingInterruptRefs = mergeRuntimeReferences(
    intent.interrupt_refs,
    [{
      id,
      uri: `interrupt://${input.run.run_id}/${node.id}${
        options.occurrence === undefined ? "" : `/${options.occurrence}`
      }`,
      node_id: node.id
    }]
  );
  const review = interruptReview(reviewInput);
  try {
    await persistWaitStepWrites(input, state, intent);
    await saveCheckpointExactly(
      input,
      waitingCheckpoint(input, intent, waitingInterruptRefs)
    );
    await createInterrupt(
      {
        interrupt_id: intent.interrupt_id,
        run: input.run,
        checkpoint_id: intent.checkpoint_id,
        node_id: intent.node_id,
        kind: intent.capability_id,
        prompt: interruptPrompt(reviewInput),
        decisions: [],
        ...(review === undefined ? {} : { review }),
        created_at: intent.created_at
      },
      {
        threadId: input.run.run_id,
        interruptStore: input.backends.interrupts,
        eventStore: input.backends.events
      }
    );
    await saveCheckpointWriteExactly(input, waitCompletionWrite(intent));
  } catch (cause) {
    if (isRuntimeDurabilityRecoveryRequired(cause)) {
      throw cause;
    }
    throw new RuntimeDurabilityRecoveryRequiredError(
      "Interrupt wait protocol requires durable reconciliation",
      {
        cause,
        details: {
          checkpoint_id: checkpoint_id,
          interrupt_id: id,
          node_id: node.id,
          run_id: input.run.run_id
        }
      }
    );
  }
  try {
    await input.observability?.recorder.addEvent("interrupt.created", {
      interrupt_id: id,
      checkpoint_id,
      node_id: node.id,
      kind: node.capability_id
    });
  } catch {
    // Checkpoint + interrupt are already durable. Telemetry cannot rewrite a
    // resumable waiting outcome into a failed run.
  }

  return {
    ...waiting,
    interrupt_refs: waitingInterruptRefs
  };
}

function interruptPrompt(reviewInput: JsonValue | undefined): string {
  if (
    reviewInput !== undefined &&
    isCheckpointPlainObject(reviewInput) &&
    typeof reviewInput.prompt === "string"
  ) {
    return reviewInput.prompt.slice(0, 32_768);
  }
  return "Human review required";
}

function interruptReview(reviewInput: JsonValue | undefined): InterruptReview | undefined {
  if (!isCheckpointPlainObject(reviewInput) || reviewInput.review === undefined) {
    return undefined;
  }
  const review = reviewInput.review;
  if (
    !isCheckpointPlainObject(review) ||
    !Array.isArray(review.targets) ||
    review.targets.length === 0 ||
    review.targets.length > 32 ||
    !Array.isArray(review.artifact_refs) ||
    review.artifact_refs.length > 128
  ) {
    throw runtimeError("Human review presentation is invalid", "runtime_state_invalid");
  }
  const approval = review.approval;
  if (
    approval !== undefined &&
    (
      !isCheckpointPlainObject(approval) ||
      typeof approval.allowed !== "boolean" ||
      typeof approval.reason !== "string" ||
      approval.reason.length === 0 ||
      approval.reason.length > 2048 ||
      Object.keys(approval).some((key) => !["allowed", "reason"].includes(key))
    )
  ) {
    throw runtimeError("Human review approval policy is invalid", "runtime_state_invalid");
  }
  const targets = review.targets.map((value) => {
    if (
      !isCheckpointPlainObject(value) ||
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      value.id.length > 128 ||
      typeof value.label !== "string" ||
      value.label.length === 0 ||
      value.label.length > 256
    ) {
      throw runtimeError("Human review target is invalid", "runtime_state_invalid");
    }
    return { id: value.id, label: value.label };
  });
  const artifactRefs = review.artifact_refs.map((value) => {
    if (
      !isCheckpointPlainObject(value) ||
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      value.id.length > 512 ||
      typeof value.uri !== "string" ||
      value.uri.length === 0 ||
      value.uri.length > 4096 ||
      (value.node_id !== undefined &&
        (typeof value.node_id !== "string" ||
          value.node_id.length === 0 ||
          value.node_id.length > 256)) ||
      Object.keys(value).some((key) => !["id", "uri", "node_id"].includes(key))
    ) {
      throw runtimeError("Human review artifact reference is invalid", "runtime_state_invalid");
    }
    return {
      id: value.id,
      uri: value.uri,
      ...(value.node_id === undefined ? {} : { node_id: value.node_id })
    };
  });
  if (
    new Set(targets.map((target) => target.id)).size !== targets.length ||
    new Set(artifactRefs.map((reference) => reference.id)).size !== artifactRefs.length
  ) {
    throw runtimeError("Human review presentation contains duplicate ids", "runtime_state_invalid");
  }
  return {
    targets,
    artifact_refs: artifactRefs,
    ...(approval === undefined
      ? {}
      : { approval: { allowed: approval.allowed as boolean, reason: approval.reason as string } })
  };
}

async function loadOrCreateWaitIntent(
  input: RunWorkflowInput,
  state: LunaRuntimeState,
  node: CompiledWorkflowNode,
  occurrence?: string
): Promise<InterruptWaitIntent> {
  const checkpointIds = checkpointIdCandidates(
    input.run.run_id,
    node.id,
    occurrence
  );
  const candidates = (await Promise.all(checkpointIds.map(async (candidateId) => {
    const writes = await listCheckpointWritesForRecovery({
      input,
      threadId: input.run.run_id,
      checkpointNs: "",
      checkpointId: candidateId,
      operation: "load_interrupt_wait_intent"
    });
    return writes.filter(
      (write) =>
        write.task_id === waitIntentTaskId(node.id) &&
        write.index === 0 &&
        write.channel === WAIT_INTENT_CHANNEL
    );
  }))).flat();
  if (candidates.length > 1) {
    throw runtimeError(
      "Interrupt wait checkpoint contains ambiguous intents",
      "runtime_state_invalid",
      { details: { checkpoint_ids: checkpointIds, node_id: node.id } }
    );
  }
  const resumeContext = checkpointResumeContext(input);
  const existing = candidates[0];
  if (existing !== undefined) {
    return parseWaitIntent(
      existing.value,
      input,
      node,
      state,
      resumeContext,
      occurrence
    );
  }

  const checkpoint_id = checkpointIds[0]!;
  const intent: InterruptWaitIntent = {
    schema_version: WAIT_INTENT_SCHEMA_VERSION,
    run_id: input.run.run_id,
    workflow_revision: input.workflow.revision,
    node_id: node.id,
    capability_id: node.capability_id,
    checkpoint_id,
    interrupt_id: interruptId(input.run.run_id, node.id, occurrence),
    created_at: new Date().toISOString(),
    artifact_refs: state.artifact_refs,
    interrupt_refs: state.interrupt_refs,
    resume_context: resumeContext
  };
  assertCheckpointJsonValue(intent);
  await saveCheckpointWriteExactly(input, waitIntentWrite(intent));
  return intent;
}

function parseWaitIntent(
  value: JsonValue,
  input: RunWorkflowInput,
  node: CompiledWorkflowNode,
  state: LunaRuntimeState,
  resumeContext: JsonObject,
  occurrence?: string
): InterruptWaitIntent {
  const intent = parseInterruptWaitIntent(value, (details) => runtimeError(
      "Interrupt wait checkpoint contains an invalid intent",
      "runtime_state_invalid",
      { details: { node_id: node.id, ...details } }
    ));
  const expected = {
    run_id: input.run.run_id,
    workflow_revision: input.workflow.revision,
    node_id: node.id,
    capability_id: node.capability_id,
    artifact_refs: state.artifact_refs,
    interrupt_refs: state.interrupt_refs,
    resume_context: resumeContext
  };
  if (
    intent.run_id !== expected.run_id ||
    intent.workflow_revision !== expected.workflow_revision ||
    intent.node_id !== expected.node_id ||
    intent.capability_id !== expected.capability_id ||
    !checkpointIdCandidates(input.run.run_id, node.id, occurrence)
      .includes(intent.checkpoint_id) ||
    !interruptIdMatches(
      intent.interrupt_id,
      input.run.run_id,
      node.id,
      occurrence
    ) ||
    !runtimeReferenceCollectionsEqual(
      intent.artifact_refs,
      expected.artifact_refs
    ) ||
    !runtimeReferenceCollectionsEqual(
      intent.interrupt_refs,
      expected.interrupt_refs
    ) ||
    stableJson(intent.resume_context) !== stableJson(expected.resume_context)
  ) {
    throw runtimeError(
      "Interrupt wait intent conflicts with this workflow execution",
      "runtime_state_invalid",
      { details: { node_id: node.id } }
    );
  }
  return intent;
}

async function persistWaitStepWrites(
  input: RunWorkflowInput,
  state: LunaRuntimeState,
  intent: InterruptWaitIntent
): Promise<void> {
  const entries = Object.entries(state.steps)
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [index, [nodeId, value]] of entries.entries()) {
    await saveCheckpointWriteExactly(input, {
      thread_id: intent.run_id,
      checkpoint_ns: "",
      checkpoint_id: intent.checkpoint_id,
      task_id: nodeId,
      index,
      channel: "steps",
      value
    });
  }
}

function waitingCheckpoint(
  input: RunWorkflowInput,
  intent: InterruptWaitIntent,
  interruptRefs: LunaRuntimeState["interrupt_refs"]
): SaveCheckpointInput {
  return {
    thread_id: intent.run_id,
    checkpoint_ns: "",
    checkpoint_id: intent.checkpoint_id,
    state_schema_version: LUNA_RUNTIME_STATE_SCHEMA_VERSION,
    state: {
      state_schema_version: LUNA_RUNTIME_STATE_SCHEMA_VERSION,
      run_status: "waiting_for_input",
      artifact_refs: intent.artifact_refs,
      interrupt_refs: interruptRefs
    },
    checkpoint: {
      v: 4,
      ts: intent.created_at,
      channel_versions: {},
      versions_seen: {}
    },
    metadata: {
      workflow_revision: input.workflow.revision,
      resume_node_id: intent.node_id,
      resume_context: intent.resume_context
    },
    created_at: intent.created_at
  };
}

export function checkpointResumeContext(input: RunWorkflowInput): JsonObject {
  const context = {
    invocation: input.invocation,
    config: input.config,
    run: input.run,
    ...(input.precompleted_steps === undefined ||
    Object.keys(input.precompleted_steps).length === 0
      ? {}
      : { precompleted_steps: input.precompleted_steps }),
    ...(input.loop_continuation === undefined
      ? {}
      : { loop_continuation: input.loop_continuation })
  };
  assertCheckpointJsonValue(context);

  return context;
}

export function resumeContextFromMetadata(metadata: JsonObject): {
  readonly invocation: JsonValue;
  readonly config: JsonValue;
  readonly run: RunHandle;
  readonly precompleted_steps?: RunWorkflowInput["precompleted_steps"];
  readonly loop_continuation?: RunWorkflowInput["loop_continuation"];
} {
  const context = metadata.resume_context;
  if (typeof context !== "object" || context === null || Array.isArray(context)) {
    throw runtimeError("Checkpoint is missing resume context", "runtime_checkpoint_schema_mismatch");
  }

  const invocation = context.invocation;
  const config = context.config;
  const run = context.run;
  const precompletedSteps = context.precompleted_steps;
  const loopContinuation = context.loop_continuation;
  if (precompletedSteps !== undefined) {
    assertCheckpointJsonObject(
      precompletedSteps,
      "$.resume_context.precompleted_steps"
    );
  }
  if (
    loopContinuation !== undefined &&
    (!isCheckpointPlainObject(loopContinuation) ||
      typeof loopContinuation.node_id !== "string" ||
      !Number.isSafeInteger(loopContinuation.iteration) ||
      typeof loopContinuation.steps !== "object" ||
      loopContinuation.steps === null ||
      Array.isArray(loopContinuation.steps) ||
      !Array.isArray(loopContinuation.artifact_refs))
  ) {
    throw runtimeError("Checkpoint loop continuation is invalid", "runtime_checkpoint_schema_mismatch");
  }
  assertCheckpointJsonObject(run, "$.resume_context.run");
  if (
    typeof run.run_id !== "string" ||
    typeof run.workflow_id !== "string" ||
    typeof run.attempt !== "number" ||
    typeof run.started_at !== "string"
  ) {
    throw runtimeError("Checkpoint resume run handle is invalid", "runtime_checkpoint_schema_mismatch");
  }

  return {
    invocation,
    config,
    run: {
      ...run,
      run_id: run.run_id,
      workflow_id: run.workflow_id,
      attempt: run.attempt,
      started_at: run.started_at
    },
    ...(precompletedSteps === undefined
      ? {}
      : { precompleted_steps: precompletedSteps }),
    ...(loopContinuation === undefined
      ? {}
      : { loop_continuation: loopContinuation as unknown as RunWorkflowInput["loop_continuation"] })
  };
}
