import {
  assertCheckpointJsonObject,
  assertCheckpointJsonValue,
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
import { runtimeError } from "../../core/runtime/errors.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";

export async function waitForHumanInput(
  input: RunWorkflowInput,
  state: LunaRuntimeState,
  node: CompiledWorkflowNode
): Promise<LunaRuntimeState> {
  const id = interruptId(input.run.run_id, node.id);
  const checkpoint_id = checkpointId(input.run.run_id, node.id);
  const waiting = markNodeWaitingForInput(state, node.id);
  await input.backends.checkpoints.saveWrites(
    Object.entries(state.steps).map(([nodeId, value], index) => ({
      thread_id: input.run.run_id,
      checkpoint_ns: "",
      checkpoint_id,
      task_id: nodeId,
      index,
      channel: "steps",
      value
    }))
  );
  await input.backends.checkpoints.save({
    thread_id: input.run.run_id,
    checkpoint_id,
    state_schema_version: LUNA_RUNTIME_STATE_SCHEMA_VERSION,
    state: {
      state_schema_version: LUNA_RUNTIME_STATE_SCHEMA_VERSION,
      run_status: "waiting_for_input",
      interrupt_refs: [{ id, uri: `interrupt://${input.run.run_id}/${node.id}`, node_id: node.id }]
    },
    metadata: {
      workflow_revision: input.workflow.revision,
      resume_node_id: node.id,
      resume_context: checkpointResumeContext(input)
    }
  });
  await createInterrupt(
    {
      interrupt_id: id,
      run: input.run,
      checkpoint_id,
      node_id: node.id,
      kind: node.capability_id,
      prompt: "",
      decisions: [],
      created_at: new Date().toISOString()
    },
    {
      threadId: input.run.run_id,
      interruptStore: input.backends.interrupts,
      eventStore: input.backends.events
    }
  );
  await input.observability?.recorder.addEvent("interrupt.created", {
    interrupt_id: id,
    checkpoint_id,
    node_id: node.id,
    kind: node.capability_id
  });

  return {
    ...waiting,
    interrupt_refs: [{ id, uri: `interrupt://${input.run.run_id}/${node.id}`, node_id: node.id }]
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

export function interruptId(runId: string, nodeId: string): string {
  return `interrupt-${runId}-${nodeId}`;
}

export function checkpointId(runId: string, nodeId: string): string {
  return `checkpoint-${runId}-${nodeId}`;
}
