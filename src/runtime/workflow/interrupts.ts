import {
  assertCheckpointJsonObject,
  assertCheckpointJsonValue,
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
import {
  listCheckpointWritesForRecovery,
  saveCheckpointExactly,
  saveCheckpointWriteExactly
} from "./checkpoint-io.js";
import {
  checkpointId,
  interruptId,
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
  node: CompiledWorkflowNode
): Promise<LunaRuntimeState> {
  const id = interruptId(input.run.run_id, node.id);
  const checkpoint_id = checkpointId(input.run.run_id, node.id);
  const waiting = markNodeWaitingForInput(state, node.id);
  const intent = await loadOrCreateWaitIntent(input, state, node);
  const waitingInterruptRefs = mergeRuntimeReferences(
    intent.interrupt_refs,
    [{ id, uri: `interrupt://${input.run.run_id}/${node.id}`, node_id: node.id }]
  );
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
        prompt: "",
        decisions: [],
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

async function loadOrCreateWaitIntent(
  input: RunWorkflowInput,
  state: LunaRuntimeState,
  node: CompiledWorkflowNode
): Promise<InterruptWaitIntent> {
  const checkpoint_id = checkpointId(input.run.run_id, node.id);
  const writes = await listCheckpointWritesForRecovery({
    input,
    threadId: input.run.run_id,
    checkpointNs: "",
    checkpointId: checkpoint_id,
    operation: "load_interrupt_wait_intent"
  });
  const candidates = writes.filter(
    (write) =>
      write.task_id === waitIntentTaskId(node.id) &&
      write.index === 0 &&
      write.channel === WAIT_INTENT_CHANNEL
  );
  if (candidates.length > 1) {
    throw runtimeError(
      "Interrupt wait checkpoint contains ambiguous intents",
      "runtime_state_invalid",
      { details: { checkpoint_id, node_id: node.id } }
    );
  }
  const resumeContext = checkpointResumeContext(input);
  const existing = candidates[0];
  if (existing !== undefined) {
    return parseWaitIntent(existing.value, input, node, state, resumeContext);
  }

  const intent: InterruptWaitIntent = {
    schema_version: WAIT_INTENT_SCHEMA_VERSION,
    run_id: input.run.run_id,
    workflow_revision: input.workflow.revision,
    node_id: node.id,
    capability_id: node.capability_id,
    checkpoint_id,
    interrupt_id: interruptId(input.run.run_id, node.id),
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
  resumeContext: JsonObject
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
    checkpoint_id: checkpointId(input.run.run_id, node.id),
    interrupt_id: interruptId(input.run.run_id, node.id),
    artifact_refs: state.artifact_refs,
    interrupt_refs: state.interrupt_refs,
    resume_context: resumeContext
  };
  if (
    intent.run_id !== expected.run_id ||
    intent.workflow_revision !== expected.workflow_revision ||
    intent.node_id !== expected.node_id ||
    intent.capability_id !== expected.capability_id ||
    intent.checkpoint_id !== expected.checkpoint_id ||
    intent.interrupt_id !== expected.interrupt_id ||
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
    run: input.run
  };
  assertCheckpointJsonValue(context);

  return context;
}

export function resumeContextFromMetadata(metadata: JsonObject): {
  readonly invocation: JsonValue;
  readonly config: JsonValue;
  readonly run: RunHandle;
} {
  const context = metadata.resume_context;
  if (typeof context !== "object" || context === null || Array.isArray(context)) {
    throw runtimeError("Checkpoint is missing resume context", "runtime_checkpoint_schema_mismatch");
  }

  const invocation = context.invocation;
  const config = context.config;
  const run = context.run;
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
    }
  };
}
