import type {
  AgentCatalogItem,
  CapabilitySummary,
  CapabilityRegistration,
  JsonValue,
} from "@/api/types"
import { humanizeTechnicalId } from "@/lib/presentation"

export type WorkflowCatalogNodeKind = "built_in" | "pattern" | "agent" | "human_gate"

export type WorkflowPaletteItem = {
  readonly id: string
  readonly kind: WorkflowCatalogNodeKind
  readonly title: string
  readonly summary: string
  readonly category: string
  readonly tags: readonly string[]
  readonly hasExternalEffect: boolean
}

export type WorkflowNodePresentation = {
  readonly title: string
  readonly summary?: string
}

export function humanizeWorkflowIdentifier(id: string): string {
  return humanizeTechnicalId(id)
}

export function workflowNodePaletteItems(
  registrations: readonly CapabilityRegistration[],
  agents: readonly AgentCatalogItem[],
): WorkflowPaletteItem[] {
  const registered = (["built_in", "pattern", "human_gate"] as const).flatMap(
    (kind) => workflowNodeRegistrations(registrations, kind).map((registration) => ({
      id: registration.id,
      kind,
      title: registration.presentation.title === registration.id
        ? humanizeWorkflowIdentifier(registration.id)
        : registration.presentation.title,
      summary: registration.presentation.summary ?? "Executa uma ação determinística disponível neste projeto.",
      category: registration.presentation.category ?? (
        kind === "human_gate" ? "Aprovação humana" : kind === "pattern" ? "Fluxo" : "Ações"
      ),
      tags: registration.presentation.tags ?? [],
      hasExternalEffect:
        registration.registration_kind === "built_in" &&
        registration.side_effect_policy !== undefined,
    })),
  )
  const agentItems = agents.map((agent) => ({
    id: agent.id,
    kind: "agent" as const,
    title: humanizeWorkflowIdentifier(agent.id),
    summary: agent.description,
    category: "Agents",
    tags: [agent.mode, ...agent.tools],
    hasExternalEffect: agent.mode === "trusted_local_write",
  }))
  return [...registered, ...agentItems].sort((left, right) =>
    left.category.localeCompare(right.category) || left.title.localeCompare(right.title),
  )
}

export function workflowNodePresentations(
  registrations: readonly CapabilityRegistration[],
  agents: readonly AgentCatalogItem[],
): ReadonlyMap<string, WorkflowNodePresentation> {
  return new Map(workflowNodePaletteItems(registrations, agents).map((item) => [
    `${item.kind}:${item.id}`,
    { title: item.title, summary: item.summary },
  ]))
}

export function workflowNodeCapabilityIds(
  capabilities: readonly CapabilitySummary[],
  kind: WorkflowCatalogNodeKind,
): string[] {
  if (kind !== "agent") return []
  return capabilities
    .filter((capability) => capability.workflow_node_types.includes(kind))
    .map((capability) => capability.id)
}

export function workflowAgentCapabilityIds(
  capabilities: readonly CapabilitySummary[],
  registrations: readonly CapabilityRegistration[],
  outputSchemaReference: string | undefined,
): string[] {
  const schemaCapability = registrations.find(
    (registration) =>
      registration.registration_kind === "schema" &&
      registration.id === outputSchemaReference,
  )?.owner.capability_id
  return [...new Set([
    ...workflowNodeCapabilityIds(capabilities, "agent"),
    schemaCapability,
  ].filter((value): value is string => value !== undefined))]
}

export function workflowNodeRegistrations(
  registrations: readonly CapabilityRegistration[],
  kind: WorkflowCatalogNodeKind,
): CapabilityRegistration[] {
  if (kind === "agent") return []
  if (kind === "human_gate") {
    return registrations.filter(
      (registration) =>
        registration.registration_kind === "gate" && registration.interrupt !== "none",
    )
  }
  return registrations.filter(
    (registration) => registration.registration_kind === kind,
  )
}

export function workflowPolicyConfig(
  registration: CapabilityRegistration | undefined,
): Record<string, JsonValue> {
  return registration?.registration_kind === "policy" &&
    registration.side_effect_operation_ids[0] !== undefined
    ? { operation_id: registration.side_effect_operation_ids[0] }
    : {}
}

export function workflowBuiltInPolicyEntry(
  registrations: readonly CapabilityRegistration[],
  registration: CapabilityRegistration | undefined,
): { uses: string; config: Record<string, JsonValue> } | undefined {
  if (
    registration?.registration_kind !== "built_in" ||
    registration.side_effect_policy === undefined
  ) {
    return undefined
  }
  const policy = registrations.find(
    (candidate) =>
      candidate.registration_kind === "policy" &&
      candidate.id === registration.side_effect_policy,
  )
  return {
    uses: registration.side_effect_policy,
    config: workflowPolicyConfig(policy),
  }
}

function policyUses(value: JsonValue, policyId: string): boolean {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.uses === policyId
}

export function reconcileWorkflowBuiltInPolicies(
  registrations: readonly CapabilityRegistration[],
  previousRegistration: CapabilityRegistration | undefined,
  nextRegistration: CapabilityRegistration | undefined,
  policies: readonly JsonValue[],
): JsonValue[] {
  const previousPolicyId = previousRegistration?.registration_kind === "built_in"
    ? previousRegistration.side_effect_policy
    : undefined
  const nextPolicyEntry = workflowBuiltInPolicyEntry(registrations, nextRegistration)
  const nextPolicyId = nextPolicyEntry?.uses

  if (previousPolicyId === nextPolicyId) return [...policies]

  const previousPolicyIndex = previousPolicyId === undefined
    ? -1
    : policies.findIndex((policy) => policyUses(policy, previousPolicyId))
  const alreadyHasNextPolicy = nextPolicyId !== undefined &&
    policies.some((policy) => policyUses(policy, nextPolicyId))

  if (previousPolicyIndex >= 0) {
    const reconciled = [...policies]
    if (nextPolicyEntry === undefined || alreadyHasNextPolicy) {
      reconciled.splice(previousPolicyIndex, 1)
    } else {
      reconciled[previousPolicyIndex] = nextPolicyEntry
    }
    return reconciled
  }

  return nextPolicyEntry === undefined || alreadyHasNextPolicy
    ? [...policies]
    : [...policies, nextPolicyEntry]
}
