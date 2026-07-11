import type { CheckpointWriteRecord } from "../../core/runtime/backends/contracts.js";
import type { JsonValue } from "../../core/runtime/json.js";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";
import { runtimeError } from "../../core/runtime/errors.js";
import {
  nodeOutputCheckpointId,
  persistedNodeDurability
} from "./node-durability.js";
import {
  listCheckpointWritesForRecovery
} from "./checkpoint-io.js";
import { assertNodeOutputMatchesSchema } from "./node-output-validation.js";
import { mergeRuntimeReferences } from "./runtime-reference-codec.js";

export type PersistedWorkflowNodeRecovery = {
  readonly stepWrites: readonly CheckpointWriteRecord[];
  readonly completedNodeIds: ReadonlySet<string>;
  readonly outputPendingByNode: ReadonlyMap<string, JsonValue>;
  readonly completedArtifactRefs: LunaRuntimeState["artifact_refs"];
  readonly completedInterruptRefs: LunaRuntimeState["interrupt_refs"];
};

export async function loadPersistedWorkflowNodeRecovery(
  input: Pick<RunWorkflowInput, "backends" | "compiled">,
  runId: string
): Promise<PersistedWorkflowNodeRecovery> {
  const nodeWrites = await Promise.all(
    input.compiled.nodes.map(async (node) => ({
      node,
      writes: await listCheckpointWritesForRecovery({
        input,
        threadId: runId,
        checkpointNs: "",
        checkpointId: nodeOutputCheckpointId(
          runId,
          input.compiled.workflow_id,
          input.compiled.workflow_revision,
          node.id
        ),
        operation: "load_persisted_node_recovery"
      })
    }))
  );
  const completedNodeIds = new Set<string>();
  const stepWrites: CheckpointWriteRecord[] = [];
  const outputPendingByNode = new Map<string, JsonValue>();
  const completedArtifactRefs: LunaRuntimeState["artifact_refs"] = [];
  const completedInterruptRefs: LunaRuntimeState["interrupt_refs"] = [];

  for (const { node, writes } of nodeWrites) {
    const durability = persistedNodeDurability({ nodeId: node.id, writes });
    if (durability.kind === "none") {
      continue;
    }
    const canonicalOutputWrite = writes.find(
      (write) =>
        write.task_id === node.id &&
        write.index === 0 &&
        write.channel === "steps"
    );
    if (canonicalOutputWrite === undefined) {
      throw runtimeError(
        "Persisted node durability has no canonical output write",
        "runtime_state_invalid",
        { details: { node_id: node.id } }
      );
    }
    stepWrites.push(canonicalOutputWrite);
    assertNodeOutputMatchesSchema(node, durability.output);
    if (durability.kind === "output_pending") {
      // A human decision is recoverable only through its exact resume protocol.
      // Re-entering an interrupt from its output write alone could republish
      // gate artifacts or reopen an already-resolved approval.
      if (node.kind !== "interrupt") {
        outputPendingByNode.set(node.id, durability.output);
      }
      continue;
    }
    completedNodeIds.add(node.id);
    completedArtifactRefs.push(...durability.artifactRefs);
    completedInterruptRefs.push(...durability.interruptRefs);
  }

  return {
    stepWrites,
    completedNodeIds,
    outputPendingByNode,
    completedArtifactRefs,
    completedInterruptRefs: mergeRuntimeReferences(completedInterruptRefs)
  };
}
