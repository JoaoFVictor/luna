import {
  assertCheckpointJsonValue,
  type JsonObject,
  type JsonValue
} from "../../core/runtime/json.js";
import {
  LUNA_RUNTIME_STATE_SCHEMA_VERSION,
  type LunaRuntimeState
} from "../../core/runtime/state.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";

type TerminalCheckpointSnapshot = JsonObject & {
  readonly state_schema_version: typeof LUNA_RUNTIME_STATE_SCHEMA_VERSION;
  readonly run_status: LunaRuntimeState["run_status"];
  readonly artifact_refs: LunaRuntimeState["artifact_refs"];
  readonly interrupt_refs: LunaRuntimeState["interrupt_refs"];
  readonly event_cursor?: string;
};

export async function saveNodeOutputWrite({
  input,
  node,
  output
}: {
  readonly input: RunWorkflowInput;
  readonly node: CompiledWorkflowNode;
  readonly output: JsonValue;
}): Promise<void> {
  assertCheckpointJsonValue(output);
  await input.backends.checkpoints.saveWrites([
    {
      thread_id: input.run.run_id,
      checkpoint_ns: "",
      checkpoint_id: `node-output-${input.run.run_id}-${node.id}`,
      task_id: node.id,
      index: 0,
      channel: "steps",
      value: output
    }
  ]);
}

export async function saveTerminalCheckpoint({
  input,
  state
}: {
  readonly input: RunWorkflowInput;
  readonly state: TerminalCheckpointSnapshot;
}): Promise<void> {
  await input.backends.checkpoints.save({
    thread_id: input.run.run_id,
    checkpoint_ns: "",
    checkpoint_id: `terminal-${input.run.run_id}-${state.run_status}`,
    state_schema_version: state.state_schema_version,
    state,
    metadata: {
      source: "terminal",
      workflow_revision: input.workflow.revision,
      run_status: state.run_status
    }
  });
}

export function terminalCheckpointSnapshot(
  state: LunaRuntimeState | JsonObject,
  runStatus: LunaRuntimeState["run_status"]
): TerminalCheckpointSnapshot {
  return {
    state_schema_version:
      state.state_schema_version === LUNA_RUNTIME_STATE_SCHEMA_VERSION
        ? state.state_schema_version
        : LUNA_RUNTIME_STATE_SCHEMA_VERSION,
    run_status: runStatus,
    artifact_refs: Array.isArray(state.artifact_refs)
      ? state.artifact_refs as LunaRuntimeState["artifact_refs"]
      : [],
    interrupt_refs: Array.isArray(state.interrupt_refs)
      ? state.interrupt_refs as LunaRuntimeState["interrupt_refs"]
      : [],
    ...(typeof state.event_cursor === "string" ? { event_cursor: state.event_cursor } : {})
  };
}
