import type { DraftValidationResult } from "@/api/types"
import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"

export type WorkflowNodeDiagnostic = {
  readonly severity: "error" | "warning"
  readonly message: string
}

const NODE_FIELD_PATH = /^\$\.nodes\[(\d+)\](?:\.|$)/u

export function workflowNodeDiagnostics(
  nodes: readonly WorkflowSourceNode[],
  diagnostics: DraftValidationResult["diagnostics"],
): ReadonlyMap<string, readonly WorkflowNodeDiagnostic[]> {
  const nodeByIndex = new Map(nodes.map((node) => [node.index, node]))
  const result = new Map<string, WorkflowNodeDiagnostic[]>()
  for (const diagnostic of diagnostics) {
    const authoritativeNode = diagnostic.node_id === undefined
      ? undefined
      : nodes.find((node) => node.id === diagnostic.node_id)
    const match = diagnostic.field_path?.match(NODE_FIELD_PATH)
    const index = match?.[1] === undefined ? undefined : Number(match[1])
    const node = authoritativeNode ?? (index === undefined ? undefined : nodeByIndex.get(index))
    if (node === undefined) continue
    result.set(node.id, [
      ...(result.get(node.id) ?? []),
      { severity: diagnostic.severity, message: diagnostic.message },
    ])
  }
  return result
}

export function workflowEdgeDiagnostics(
  diagnostics: DraftValidationResult["diagnostics"],
): ReadonlyMap<string, readonly WorkflowNodeDiagnostic[]> {
  const result = new Map<string, WorkflowNodeDiagnostic[]>()
  for (const diagnostic of diagnostics) {
    if (diagnostic.edge === undefined) continue
    const key = `${diagnostic.edge.from}\u0000${diagnostic.edge.to}`
    result.set(key, [
      ...(result.get(key) ?? []),
      { severity: diagnostic.severity, message: diagnostic.message },
    ])
  }
  return result
}
