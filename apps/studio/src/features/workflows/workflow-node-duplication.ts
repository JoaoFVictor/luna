import type { JsonValue, YamlSourceOperation } from "@/api/types"
import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"

function copiedNodeId(
  originalId: string,
  nodes: readonly WorkflowSourceNode[],
): string {
  const used = new Set(nodes.map((node) => node.id))
  const base = `${originalId}_copy`
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}_${suffix}`)) suffix += 1
  return `${base}_${suffix}`
}

export function duplicateWorkflowNodeOperations(
  nodes: readonly WorkflowSourceNode[],
  value: Readonly<Record<string, JsonValue>>,
  afterNodeId?: string,
): { readonly id: string; readonly operations: readonly YamlSourceOperation[] } | undefined {
  if (typeof value.id !== "string") return undefined
  if (afterNodeId !== undefined && !nodes.some((node) => node.id === afterNodeId)) {
    return undefined
  }
  const id = copiedNodeId(value.id, nodes)
  const copy: Record<string, JsonValue> = { ...value, id }
  if (afterNodeId === undefined) delete copy.after
  else copy.after = [afterNodeId]
  const anchor = afterNodeId === undefined
    ? undefined
    : nodes.find((node) => node.id === afterNodeId)
  return {
    id,
    operations: [{
      op: "sequence_insert",
      path: ["nodes"],
      ...(anchor === undefined ? {} : { index: anchor.index + 1 }),
      value: copy,
    }],
  }
}
