import type { CheckpointWriteRecord } from "../../core/runtime/backends/contracts.js";
import {
  assertCheckpointJsonValue,
  isCheckpointPlainObject,
  type JsonObject,
  type JsonValue
} from "../../core/runtime/json.js";
import type {
  LunaRuntimeState,
  RuntimeArtifactRef,
  RuntimeInterruptRef
} from "../../core/runtime/state.js";
import { runtimeError } from "../../core/runtime/errors.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";
import { sha256Digest } from "../../core/workflow/definition-digests.js";
import { saveCheckpointWriteExactly } from "./checkpoint-io.js";
import {
  encodeRuntimeReference,
  parseRuntimeReference
} from "./runtime-reference-codec.js";

const NODE_COMPLETION_SCHEMA_VERSION = 2;
const NODE_COMPLETION_CHANNEL = "node_completion";

export type PersistedNodeDurability =
  | { readonly kind: "none" }
  | {
      readonly kind: "output_pending";
      readonly output: JsonValue;
    }
  | {
      readonly kind: "completed";
      readonly output: JsonValue;
      readonly artifactRefs: LunaRuntimeState["artifact_refs"];
      readonly interruptRefs: LunaRuntimeState["interrupt_refs"];
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
  await saveCheckpointWriteExactly(input, {
    thread_id: input.run.run_id,
    checkpoint_ns: "",
    checkpoint_id: nodeOutputCheckpointId(
      input.run.run_id,
      input.compiled.workflow_id,
      input.compiled.workflow_revision,
      node.id
    ),
    task_id: node.id,
    index: 0,
    channel: "steps",
    value: output
  });
}

export function nodeOutputCheckpointId(
  runId: string,
  workflowId: string,
  workflowRevision: string,
  nodeId: string
): string {
  const executionDigest = sha256Digest({
    workflow_id: workflowId,
    workflow_revision: workflowRevision
  }).slice("sha256:".length);
  return `node-output-v2-${runId}-${executionDigest}-${nodeId}`;
}

export async function saveNodeCompletionWrite({
  input,
  node,
  output,
  artifactRefs,
  interruptRefs
}: {
  readonly input: RunWorkflowInput;
  readonly node: CompiledWorkflowNode;
  readonly output: JsonValue;
  readonly artifactRefs: LunaRuntimeState["artifact_refs"];
  readonly interruptRefs: LunaRuntimeState["interrupt_refs"];
}): Promise<void> {
  await saveCheckpointWriteExactly(input, {
    thread_id: input.run.run_id,
    checkpoint_ns: "",
    checkpoint_id: nodeOutputCheckpointId(
      input.run.run_id,
      input.compiled.workflow_id,
      input.compiled.workflow_revision,
      node.id
    ),
    task_id: node.id,
    index: 1,
    channel: NODE_COMPLETION_CHANNEL,
    value: nodeCompletionMarker(output, artifactRefs, interruptRefs)
  });
}

export function persistedNodeDurability({
  nodeId,
  writes
}: {
  readonly nodeId: string;
  readonly writes: readonly CheckpointWriteRecord[];
}): PersistedNodeDurability {
  const unexpectedWrite = writes.find(
    (write) =>
      write.task_id !== nodeId ||
      !(
        (write.channel === "steps" && write.index === 0) ||
        (write.channel === NODE_COMPLETION_CHANNEL && write.index === 1)
      )
  );
  if (unexpectedWrite !== undefined) {
    throw invalidNodeDurability(
      "Node output checkpoint contains a foreign or non-canonical write",
      nodeId,
      {
        write_task_id: unexpectedWrite.task_id,
        write_index: unexpectedWrite.index,
        write_channel: unexpectedWrite.channel
      }
    );
  }
  const outputWrites = writes.filter(
    (write) => write.task_id === nodeId && write.channel === "steps"
  );
  const completionWrites = writes.filter(
    (write) =>
      write.task_id === nodeId && write.channel === NODE_COMPLETION_CHANNEL
  );
  if (outputWrites.length === 0) {
    if (completionWrites.length > 0) {
      throw invalidNodeDurability(
        "Node completion marker exists without its output write",
        nodeId
      );
    }
    return { kind: "none" };
  }
  if (outputWrites.length !== 1 || outputWrites[0]?.index !== 0) {
    throw invalidNodeDurability(
      "Node output checkpoint contains ambiguous output writes",
      nodeId
    );
  }

  const output = outputWrites[0].value;
  if (completionWrites.length === 0) {
    return { kind: "output_pending", output };
  }
  if (completionWrites.length !== 1 || completionWrites[0]?.index !== 1) {
    throw invalidNodeDurability(
      "Node output checkpoint contains ambiguous completion markers",
      nodeId
    );
  }

  const marker = completionWrites[0].value;
  if (
    !isCheckpointPlainObject(marker) ||
    (marker.schema_version !== 1 &&
      marker.schema_version !== NODE_COMPLETION_SCHEMA_VERSION) ||
    typeof marker.output_digest !== "string" ||
    marker.output_digest !== sha256Digest(output) ||
    !Array.isArray(marker.artifact_refs) ||
    (marker.schema_version === NODE_COMPLETION_SCHEMA_VERSION &&
      !Array.isArray(marker.interrupt_refs)) ||
    Object.keys(marker).some(
      (key) => ![
        "schema_version",
        "output_digest",
        "artifact_refs",
        ...(marker.schema_version === NODE_COMPLETION_SCHEMA_VERSION
          ? ["interrupt_refs"]
          : [])
      ].includes(key)
    )
  ) {
    throw invalidNodeDurability(
      "Node output checkpoint contains an invalid completion marker",
      nodeId
    );
  }

  const markerInterruptRefs =
    marker.schema_version === NODE_COMPLETION_SCHEMA_VERSION &&
    Array.isArray(marker.interrupt_refs)
      ? marker.interrupt_refs
      : [];

  return {
    kind: "completed",
    output,
    artifactRefs: marker.artifact_refs.map((artifact, index) =>
      parseRuntimeReference<RuntimeArtifactRef>(artifact, () =>
        invalidNodeDurability(
          "Node completion marker contains an invalid artifact reference",
          nodeId,
          { artifact_index: index }
        )
      )
    ),
    interruptRefs: markerInterruptRefs.map((interrupt, index) =>
      parseRuntimeReference<RuntimeInterruptRef>(interrupt, () =>
        invalidNodeDurability(
          "Node completion marker contains an invalid interrupt reference",
          nodeId,
          { interrupt_index: index }
        )
      )
    )
  };
}

function nodeCompletionMarker(
  output: JsonValue,
  artifactRefs: LunaRuntimeState["artifact_refs"],
  interruptRefs: LunaRuntimeState["interrupt_refs"]
): JsonObject {
  return {
    schema_version: NODE_COMPLETION_SCHEMA_VERSION,
    output_digest: sha256Digest(output),
    artifact_refs: artifactRefs.map(encodeRuntimeReference),
    interrupt_refs: interruptRefs.map(encodeRuntimeReference)
  };
}

function invalidNodeDurability(
  message: string,
  nodeId: string,
  details: Record<string, unknown> = {}
): Error {
  return runtimeError(message, "runtime_state_invalid", {
    details: { node_id: nodeId, ...details }
  });
}
