import type {
  SaveCheckpointInput
} from "../../core/runtime/backends/contracts.js";
import type { JsonObject } from "../../core/runtime/json.js";
import {
  LUNA_RUNTIME_STATE_SCHEMA_VERSION,
  type LunaRuntimeState
} from "../../core/runtime/state.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";
import { checkpointMatchesInput } from "./checkpoint-io.js";

type TerminalCheckpointSnapshot = JsonObject & {
  readonly state_schema_version: typeof LUNA_RUNTIME_STATE_SCHEMA_VERSION;
  readonly run_status: LunaRuntimeState["run_status"];
  readonly artifact_refs: LunaRuntimeState["artifact_refs"];
  readonly interrupt_refs: LunaRuntimeState["interrupt_refs"];
  readonly event_cursor?: string;
};

export async function saveTerminalCheckpoint({
  input,
  state
}: {
  readonly input: RunWorkflowInput;
  readonly state: TerminalCheckpointSnapshot;
}): Promise<void> {
  const checkpointId = `terminal-${input.run.run_id}-${state.run_status}`;
  const checkpoint: SaveCheckpointInput = {
    thread_id: input.run.run_id,
    checkpoint_ns: "",
    checkpoint_id: checkpointId,
    state_schema_version: state.state_schema_version,
    state,
    metadata: {
      source: "terminal",
      workflow_revision: input.workflow.revision,
      run_status: state.run_status
    }
  };
  try {
    await input.backends.checkpoints.save(checkpoint);
  } catch (cause) {
    const committed = await input.backends.checkpoints.load(
      input.run.run_id,
      { checkpointId, checkpointNs: "" }
    ).catch(() => undefined);
    if (committed !== undefined && checkpointMatchesInput(committed, checkpoint)) {
      return;
    }
    throw cause;
  }
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
    ...(typeof state.event_cursor === "string"
      ? { event_cursor: state.event_cursor }
      : {})
  };
}
