import type { CheckpointWriteRecord } from "../../core/runtime/backends/contracts.js";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import { runtimeError } from "../../core/runtime/errors.js";
import {
  NODE_OUTPUT_JOURNAL_CHANNEL,
  nodeOutputCheckpointId,
  persistedNodeDurability
} from "./node-durability.js";
import {
  listCheckpointWritesForRecovery
} from "./checkpoint-io.js";
import { assertNodeOutputMatchesSchema } from "./node-output-validation.js";
import { mergeRuntimeReferences } from "./runtime-reference-codec.js";
import type { PersistedNodeDurability } from "./node-durability.js";

export type PersistedPendingNodeOutput = Extract<
  PersistedNodeDurability,
  { readonly kind: "output_pending" }
>;

export type PersistedWorkflowNodeRecovery = {
  readonly stepWrites: readonly CheckpointWriteRecord[];
  readonly completedNodeIds: ReadonlySet<string>;
  readonly outputPendingByNode: ReadonlyMap<string, PersistedPendingNodeOutput>;
  readonly completedArtifactRefs: LunaRuntimeState["artifact_refs"];
  readonly completedInterruptRefs: LunaRuntimeState["interrupt_refs"];
};

export async function loadPersistedNodeDurability(
  input: Pick<RunWorkflowInput, "backends" | "compiled">,
  runId: string,
  node: CompiledWorkflowNode
): Promise<PersistedNodeDurability> {
  const writes = await listCheckpointWritesForRecovery({
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
  });
  return persistedNodeDurability({ nodeId: node.id, writes });
}

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
  const outputPendingByNode = new Map<string, PersistedPendingNodeOutput>();
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
        (write.channel === "steps" ||
          write.channel === NODE_OUTPUT_JOURNAL_CHANNEL)
    );
    if (canonicalOutputWrite === undefined) {
      throw runtimeError(
        "Persisted node durability has no canonical output write",
        "runtime_state_invalid",
        { details: { node_id: node.id } }
      );
    }
    stepWrites.push({
      ...canonicalOutputWrite,
      channel: "steps",
      value: durability.output
    });
    assertNodeOutputMatchesSchema(node, durability.output);
    if (durability.kind === "output_pending") {
      // A human decision is recoverable only through its exact resume protocol.
      // Re-entering an interrupt from its output write alone could republish
      // gate artifacts or reopen an already-resolved approval.
      if (node.kind !== "interrupt") {
        outputPendingByNode.set(node.id, durability);
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
