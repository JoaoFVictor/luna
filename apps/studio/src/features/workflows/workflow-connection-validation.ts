import type { CapabilityRegistration } from "@/api/types"
import { workflowDependencyExecutionStageIssue } from "@/features/workflows/workflow-node-execution-stage"
import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"
import { workflowDependencyWouldCycle } from "@/features/workflows/workflow-source-model"

export function workflowConnectionIssue(
  nodes: readonly WorkflowSourceNode[],
  edges: readonly { readonly from: string; readonly to: string }[],
  sourceId: string,
  targetId: string,
  registrations: readonly CapabilityRegistration[],
): string | undefined {
  if (sourceId === targetId) return "Um passo não pode depender dele mesmo."
  if (edges.some((edge) => edge.from === sourceId && edge.to === targetId)) {
    return "Esses passos já estão conectados."
  }
  if (workflowDependencyWouldCycle(nodes, targetId, sourceId)) {
    return "Essa conexão criaria um ciclo. Workflows precisam seguir em uma única direção."
  }
  const source = nodes.find((node) => node.id === sourceId)
  const target = nodes.find((node) => node.id === targetId)
  if (source !== undefined && target !== undefined) {
    return workflowDependencyExecutionStageIssue(
      registrations,
      { kind: source.type, registrationId: source.registrationId },
      { kind: target.type, registrationId: target.registrationId },
    )
  }
  return undefined
}
