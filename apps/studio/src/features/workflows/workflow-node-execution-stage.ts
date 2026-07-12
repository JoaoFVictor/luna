import type { CapabilityRegistration } from "@/api/types"
import type { WorkflowCatalogNodeKind } from "@/features/workflows/workflow-node-catalog"
import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"

export type WorkflowNodeRegistrationReference = {
  readonly kind: WorkflowCatalogNodeKind
  readonly registrationId: string
}

function isDeferredFinalReport(
  registrations: readonly CapabilityRegistration[],
  node: WorkflowNodeRegistrationReference,
): boolean {
  if (node.kind !== "built_in") return false
  const registration = registrations.find((candidate) => candidate.id === node.registrationId)
  return registration?.registration_kind === "built_in" &&
    registration.deferred_lifecycle === "final_report"
}

export function workflowDependencyExecutionStageIssue(
  registrations: readonly CapabilityRegistration[],
  source: WorkflowNodeRegistrationReference,
  target: WorkflowNodeRegistrationReference,
): string | undefined {
  if (!isDeferredFinalReport(registrations, source) || isDeferredFinalReport(registrations, target)) {
    return undefined
  }
  return "Este passo gera um resultado final e deve ficar depois das etapas normais do fluxo. Adicione o próximo passo antes dele."
}

export function workflowNodeInsertionExecutionStageIssue(
  registrations: readonly CapabilityRegistration[],
  nodes: readonly WorkflowSourceNode[],
  candidate: WorkflowNodeRegistrationReference,
  afterNodeId: string | undefined,
  beforeNodeId: string | undefined,
): string | undefined {
  const afterNode = nodes.find((node) => node.id === afterNodeId)
  const beforeNode = nodes.find((node) => node.id === beforeNodeId)
  return (
    afterNode === undefined
      ? undefined
      : workflowDependencyExecutionStageIssue(
          registrations,
          { kind: afterNode.type, registrationId: afterNode.registrationId },
          candidate,
        )
  ) ?? (
    beforeNode === undefined
      ? undefined
      : workflowDependencyExecutionStageIssue(
          registrations,
          candidate,
          { kind: beforeNode.type, registrationId: beforeNode.registrationId },
        )
  )
}
