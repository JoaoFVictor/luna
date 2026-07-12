import type {
  AgentCatalogItem,
  CapabilityCatalog,
  CapabilityRegistration,
  JsonValue,
  WorkflowSummary,
  YamlSourceOperation,
} from "@/api/types"
import {
  workflowAgentCapabilityIds,
  workflowBuiltInPolicyEntry,
  type WorkflowCatalogNodeKind,
} from "@/features/workflows/workflow-node-catalog"
import {
  addWorkflowCapabilityOperations,
  ensureWorkflowRepositoryRequirementOperations,
  workflowNodeField,
  type WorkflowSourceNode,
} from "@/features/workflows/workflow-source-model"
import { workflowNodeInsertionExecutionStageIssue } from "@/features/workflows/workflow-node-execution-stage"
import { workflowCompositionIssue } from "@/features/workflows/workflow-composition-compatibility"

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
  workflow: WorkflowSummary | undefined,
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
  if (kind === "workflow") {
    const node: Record<string, JsonValue> = {
      id,
      type: "workflow",
      workflow: registrationId,
    }
    const input = workflow === undefined
      ? undefined
      : requiredSchemaDefaults(workflow.input_schema_content)
    if (input !== undefined) node.input = input
    if (afterNodeId !== undefined) node.after = [afterNodeId]
    return node
  }
  const node: Record<string, JsonValue> = {
    id,
    type: kind,
    uses: registrationId,
  }
  const input = registration === undefined || !("input_schema" in registration)
    ? undefined
    : requiredSchemaDefaults(registration.input_schema)
  if (input !== undefined) node.input = input
  if (afterNodeId !== undefined) node.after = [afterNodeId]
  const policy = kind === "built_in"
    ? workflowBuiltInPolicyEntry(registrations, registration)
    : undefined
  if (policy !== undefined) node.policies = [policy]
  return node
}

function schemaDefault(schema: JsonValue): JsonValue | undefined {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return undefined
  if (schema.default !== undefined) return schema.default
  if (schema.const !== undefined) return schema.const
  if (Array.isArray(schema.enum) && schema.enum[0] !== undefined) return schema.enum[0]
  if (schema.type === "object") {
    const properties = schema.properties !== null &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
      ? schema.properties
      : {}
    const required = Array.isArray(schema.required)
      ? schema.required.filter((field): field is string => typeof field === "string")
      : []
    const defaults = required.flatMap((field) => {
      const value = schemaDefault(properties[field] ?? null)
      return value === undefined ? [] : [[field, value] as const]
    })
    return defaults.length === 0 ? undefined : Object.fromEntries(defaults)
  }
  return undefined
}

function requiredSchemaDefaults(schema: JsonValue): Record<string, JsonValue> | undefined {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return undefined
  if (!Array.isArray(schema.required) || schema.required.length === 0) return undefined
  const defaults = schemaDefault(schema)
  return defaults !== undefined && defaults !== null && typeof defaults === "object" && !Array.isArray(defaults)
    ? defaults
    : undefined
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
  workflows = [],
  kind,
  registrationId,
  afterNodeId,
  beforeNodeId,
}: {
  source: JsonValue
  nodes: readonly WorkflowSourceNode[]
  library: CapabilityCatalog
  agents: readonly AgentCatalogItem[]
  workflows?: readonly WorkflowSummary[]
  kind: WorkflowCatalogNodeKind
  registrationId: string
  afterNodeId?: string
  beforeNodeId?: string
}): { readonly id: string; readonly operations: readonly YamlSourceOperation[] } | undefined {
  const afterNode = afterNodeId === undefined
    ? undefined
    : nodes.find((node) => node.id === afterNodeId)
  if (afterNodeId !== undefined && afterNode === undefined) return undefined
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
  const workflow = workflows.find((candidate) => candidate.id === registrationId)
  const registration = library.registrations.find((candidate) => candidate.id === registrationId)
  if (
    (kind === "agent" && agent === undefined) ||
    (kind === "workflow" && workflow === undefined) ||
    (kind !== "agent" && kind !== "workflow" && registration === undefined)
  ) {
    return undefined
  }
  if (
    kind === "workflow" &&
    workflow !== undefined &&
    workflowCompositionIssue(source, workflow) !== undefined
  ) return undefined
  const candidate = { kind, registrationId }
  if (workflowNodeInsertionExecutionStageIssue(
    library.registrations,
    nodes,
    candidate,
    afterNodeId,
    beforeNodeId,
  ) !== undefined) return undefined
  const capabilities = selectionCapabilities(library, kind, registrationId, agent)
  if (kind !== "workflow" && capabilities.length === 0) return undefined
  const id = suggestWorkflowNodeId(registrationId, nodes)
  const operations = addWorkflowCapabilityOperations(source, capabilities)
  operations.push(...ensureWorkflowRepositoryRequirementOperations(
    source,
    kind === "workflow"
      ? workflow?.requires_repository === true
      : registration?.registration_kind === "built_in" && registration.requires_repository === true,
  ))
  operations.push({
    op: "sequence_insert",
    path: ["nodes"],
    value: newNode(
      kind,
      id,
      registrationId,
      registration,
      agent,
      workflow,
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
