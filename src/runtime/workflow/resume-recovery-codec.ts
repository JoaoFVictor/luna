import type { ResumeWorkflowInput } from "../../core/workflow/execution-contracts.js";
import {
  isCheckpointPlainObject,
  stableJson,
  type JsonObject,
  type JsonValue
} from "../../core/runtime/json.js";
import type { CheckpointWriteRecord } from "../../core/runtime/backends/contracts.js";
import type {
  LunaRuntimeState,
  RuntimeArtifactRef,
  RuntimeInterruptRef
} from "../../core/runtime/state.js";
import { runtimeError } from "../../core/runtime/errors.js";
import { listCheckpointWritesForRecovery } from "./checkpoint-io.js";
import { resumeContextFromMetadata } from "./interrupts.js";
import { loadPersistedWorkflowNodeRecovery } from "./persisted-node-recovery.js";
import type { PersistedPendingNodeOutput } from "./persisted-node-recovery.js";
import {
  encodeRuntimeReference,
  parseRuntimeReference
} from "./runtime-reference-codec.js";

const RESUME_COMPLETION_SCHEMA_VERSION = 1;
export const RESUME_COMPLETION_CHANNEL = "resume_completion";

export type DurableResumeCompletion = {
  readonly artifactRefs: LunaRuntimeState["artifact_refs"];
};

export type ResumeWrites = {
  readonly resumeCheckpointWrites: readonly CheckpointWriteRecord[];
  readonly stepWrites: readonly CheckpointWriteRecord[];
  readonly completedNodeIds: ReadonlySet<string>;
  readonly outputPendingByNode: ReadonlyMap<string, PersistedPendingNodeOutput>;
  readonly completedArtifactRefs: LunaRuntimeState["artifact_refs"];
  readonly completedInterruptRefs: LunaRuntimeState["interrupt_refs"];
};

export async function loadResumeWrites<TInput extends ResumeWorkflowInput>({
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

export function nextDecisionWriteIndex(
  writes: readonly CheckpointWriteRecord[],
  resumeNodeId: string
): number {
  return writes
    .filter((write) => write.task_id === resumeNodeId)
    .reduce((nextIndex, write) => Math.max(nextIndex, write.index + 1), 0);
}

export function resumeCompletionTaskId(resumeNodeId: string): string {
  return `__luna_resume_completion__:${resumeNodeId}`;
}

export function resumeCompletionMarker(
  decision: JsonValue,
  artifactRefs: LunaRuntimeState["artifact_refs"]
): JsonObject {
  return {
    schema_version: RESUME_COMPLETION_SCHEMA_VERSION,
    decision,
    artifact_refs: artifactRefs.map(encodeRuntimeReference)
  };
}

export function resumeCompletionFromWrites({
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

export function checkpointArtifactRefs(
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

export function checkpointInterruptRefs(
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

export function requiredResumeInterruptRef(
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
