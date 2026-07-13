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
import {
  NodeBinaryAssetChannelSchema,
  type NodeBinaryAssetChannel
} from "../../core/runtime/artifacts/binary-asset.js";
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
export const NODE_OUTPUT_JOURNAL_CHANNEL = "node_output_v2";
// The channel, not any workflow-owned JSON field, selects this codec. Current
// writes always use it and always wrap the public output, with or without
// binary assets. The old `steps` channel remains opaque domain JSON.
const NODE_OUTPUT_ENVELOPE_KIND = "luna.runtime.node-output-envelope";
const NODE_OUTPUT_ENVELOPE_SCHEMA_VERSION = 2;

export type NodeDurabilityLocation = {
  readonly thread_id: string;
  readonly checkpoint_ns: string;
  readonly checkpoint_id: string;
  readonly task_id: string;
};

export type PersistedNodeDurability =
  | { readonly kind: "none" }
  | {
      readonly kind: "output_pending";
      readonly output: JsonValue;
      readonly binaryAssets?: NodeBinaryAssetChannel;
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
  output,
  binaryAssets
}: {
  readonly input: RunWorkflowInput;
  readonly node: CompiledWorkflowNode;
  readonly output: JsonValue;
  readonly binaryAssets?: NodeBinaryAssetChannel;
}): Promise<void> {
  await saveNodeOutputAt({
    input,
    location: nodeDurabilityLocation(input, node),
    output,
    binaryAssets
  });
}

export async function saveNodeOutputAt({
  input,
  location,
  output,
  binaryAssets
}: {
  readonly input: Pick<RunWorkflowInput, "backends">;
  readonly location: NodeDurabilityLocation;
  readonly output: JsonValue;
  readonly binaryAssets?: NodeBinaryAssetChannel;
}): Promise<void> {
  assertCheckpointJsonValue(output);
  const value = nodeOutputEnvelope(output, binaryAssets);
  await saveCheckpointWriteExactly(input, {
    ...location,
    index: 0,
    channel: NODE_OUTPUT_JOURNAL_CHANNEL,
    value
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
  await saveNodeCompletionAt({
    input,
    location: nodeDurabilityLocation(input, node),
    output,
    artifactRefs,
    interruptRefs
  });
}

export async function saveNodeCompletionAt({
  input,
  location,
  output,
  artifactRefs,
  interruptRefs
}: {
  readonly input: RunWorkflowInput;
  readonly location: NodeDurabilityLocation;
  readonly output: JsonValue;
  readonly artifactRefs: LunaRuntimeState["artifact_refs"];
  readonly interruptRefs: LunaRuntimeState["interrupt_refs"];
}): Promise<void> {
  await saveCheckpointWriteExactly(input, {
    ...location,
    index: 1,
    channel: NODE_COMPLETION_CHANNEL,
    value: nodeCompletionMarker(output, artifactRefs, interruptRefs)
  });
}

function nodeDurabilityLocation(
  input: RunWorkflowInput,
  node: CompiledWorkflowNode
): NodeDurabilityLocation {
  return {
    thread_id: input.run.run_id,
    checkpoint_ns: "",
    checkpoint_id: nodeOutputCheckpointId(
      input.run.run_id,
      input.compiled.workflow_id,
      input.compiled.workflow_revision,
      node.id
    ),
    task_id: node.id
  };
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
        ((write.channel === "steps" ||
          write.channel === NODE_OUTPUT_JOURNAL_CHANNEL) &&
          write.index === 0) ||
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
    (write) =>
      write.task_id === nodeId &&
      (write.channel === "steps" ||
        write.channel === NODE_OUTPUT_JOURNAL_CHANNEL)
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

  const outputWrite = outputWrites[0];
  const decodedOutput = outputWrite.channel === NODE_OUTPUT_JOURNAL_CHANNEL
    ? decodeCurrentNodeOutputEnvelope(outputWrite.value, nodeId)
    : { output: outputWrite.value };
  const output = decodedOutput.output;
  if (completionWrites.length === 0) {
    return {
      kind: "output_pending",
      output,
      ...(decodedOutput.binaryAssets === undefined
        ? {}
        : { binaryAssets: decodedOutput.binaryAssets })
    };
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

function nodeOutputEnvelope(
  output: JsonValue,
  binaryAssets: NodeBinaryAssetChannel | undefined
): JsonValue {
  const parsed = binaryAssets === undefined
    ? undefined
    : NodeBinaryAssetChannelSchema.safeParse(binaryAssets);
  if (parsed !== undefined && !parsed.success) {
    throw runtimeError(
      "Node binary asset channel cannot be persisted",
      "runtime_state_invalid"
    );
  }
  return {
    kind: NODE_OUTPUT_ENVELOPE_KIND,
    schema_version: NODE_OUTPUT_ENVELOPE_SCHEMA_VERSION,
    output,
    ...(parsed === undefined ? {} : { binary_assets: parsed.data })
  };
}

function decodeCurrentNodeOutputEnvelope(
  value: JsonValue,
  nodeId: string
): { readonly output: JsonValue; readonly binaryAssets?: NodeBinaryAssetChannel } {
  const assets = isCheckpointPlainObject(value) && "binary_assets" in value
    ? NodeBinaryAssetChannelSchema.safeParse(value.binary_assets)
    : undefined;
  if (
    !isCheckpointPlainObject(value) ||
    value.kind !== NODE_OUTPUT_ENVELOPE_KIND ||
    value.schema_version !== NODE_OUTPUT_ENVELOPE_SCHEMA_VERSION ||
    !("output" in value) ||
    (assets !== undefined && !assets.success) ||
    Object.keys(value).some(
      (key) => !["kind", "schema_version", "output", "binary_assets"].includes(key)
    )
  ) {
    throw invalidNodeDurability(
      "Node output checkpoint contains an invalid node output envelope",
      nodeId
    );
  }
  return {
    output: value.output,
    ...(assets === undefined ? {} : { binaryAssets: assets.data })
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
