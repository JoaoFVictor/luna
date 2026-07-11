import type {
  AgentCatalogItem,
  CapabilityCatalog,
  CapabilityRegistration,
  JsonValue,
  YamlSourceOperation,
} from "@/api/types"
import {
  workflowAgentCapabilityIds,
  workflowBuiltInPolicyEntry,
  type WorkflowCatalogNodeKind,
} from "@/features/workflows/workflow-node-catalog"
import {
  addWorkflowCapabilityOperations,
  workflowNodeField,
  type WorkflowSourceNode,
} from "@/features/workflows/workflow-source-model"

function selectionCapabilities(
  library: CapabilityCatalog,
  kind: WorkflowCatalogNodeKind,
  registrationId: string,
  agent: AgentCatalogItem | undefined,
): string[] {
  const registration = library.registrations.find((item) => item.id === registrationId)
  const policyCapability = registration?.registration_kind === "built_in" &&
    registration.side_effect_policy !== undefined
    ? library.registrations.find((item) => item.id === registration.side_effect_policy)?.owner.capability_id
    : undefined
  return [...new Set([
    ...(kind === "agent"
      ? workflowAgentCapabilityIds(
          library.capabilities,
          library.registrations,
          agent?.output_schema_reference,
        )
      : [registration?.owner.capability_id]),
    policyCapability,
  ].filter((value): value is string => value !== undefined))]
}

function newNode(
  kind: WorkflowCatalogNodeKind,
  id: string,
  registrationId: string,
  registration: CapabilityRegistration | undefined,
  agent: AgentCatalogItem | undefined,
  registrations: readonly CapabilityRegistration[],
  afterNodeId: string | undefined,
): Record<string, JsonValue> {
  if (kind === "agent") {
    const node: Record<string, JsonValue> = {
      id,
      type: "agent",
      agent: registrationId,
      output_schema: agent?.output_schema_reference ?? "output.schema.json",
    }
    if (afterNodeId !== undefined) node.after = [afterNodeId]
    return node
  }
  const node: Record<string, JsonValue> = {
    id,
    type: kind,
    uses: registrationId,
  }
  if (afterNodeId !== undefined) node.after = [afterNodeId]
  const policy = kind === "built_in"
    ? workflowBuiltInPolicyEntry(registrations, registration)
    : undefined
  if (policy !== undefined) node.policies = [policy]
  return node
}

export function suggestWorkflowNodeId(
  registrationId: string,
  nodes: readonly WorkflowSourceNode[],
): string {
  const base = registrationId
    .split(".")
    .at(-1)
    ?.toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "") || "step"
  const used = new Set(nodes.map((node) => node.id))
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}_${suffix}`)) suffix += 1
  return `${base}_${suffix}`
}

export function createWorkflowNodeOperations({
  source,
  nodes,
  library,
  agents,
  kind,
  registrationId,
  afterNodeId,
  beforeNodeId,
}: {
  source: JsonValue
  nodes: readonly WorkflowSourceNode[]
  library: CapabilityCatalog
  agents: readonly AgentCatalogItem[]
  kind: WorkflowCatalogNodeKind
  registrationId: string
  afterNodeId?: string
  beforeNodeId?: string
}): { readonly id: string; readonly operations: readonly YamlSourceOperation[] } | undefined {
  if (afterNodeId !== undefined && !nodes.some((node) => node.id === afterNodeId)) return undefined
  const beforeNode = beforeNodeId === undefined
    ? undefined
    : nodes.find((node) => node.id === beforeNodeId)
  const beforeDependencies = beforeNode === undefined
    ? undefined
    : workflowNodeField(beforeNode, "after")
  if (
    beforeNodeId !== undefined &&
    (
      afterNodeId === undefined ||
      !Array.isArray(beforeDependencies) ||
      !beforeDependencies.includes(afterNodeId)
    )
  ) return undefined
  const agent = agents.find((candidate) => candidate.id === registrationId)
  const registration = library.registrations.find((candidate) => candidate.id === registrationId)
  if ((kind === "agent" && agent === undefined) || (kind !== "agent" && registration === undefined)) {
    return undefined
  }
  const capabilities = selectionCapabilities(library, kind, registrationId, agent)
  if (capabilities.length === 0) return undefined
  const id = suggestWorkflowNodeId(registrationId, nodes)
  const operations = addWorkflowCapabilityOperations(source, capabilities)
  operations.push({
    op: "sequence_insert",
    path: ["nodes"],
    value: newNode(
      kind,
      id,
      registrationId,
      registration,
      agent,
      library.registrations,
      afterNodeId,
    ),
  })
  if (beforeNode !== undefined && Array.isArray(beforeDependencies)) {
    operations.push({
      op: "set",
      path: ["nodes", beforeNode.index, "after"],
      value: beforeDependencies.map((dependency) => dependency === afterNodeId ? id : dependency),
    })
  }
  return { id, operations }
}
