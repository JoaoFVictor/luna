import type { AgentCatalogItem, CapabilityCatalog, JsonValue } from "@/api/types"
import {
  workflowNodeField,
  workflowSourceOutlineEntries,
  workflowSourceNodes,
  type WorkflowSourceNode,
} from "@/features/workflows/workflow-source-model"

export type WorkflowSideEffectPreview = {
  nodeId: string
  source: "policy" | "agent_tools" | "catalog_uncertainty"
  semantics: "read" | "write" | "unknown"
  description: string
  operationIds: readonly string[]
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function patternAgentReferences(
  node: WorkflowSourceNode,
  uncertainty: (description: string) => void,
): Set<string> {
  const references = new Set<string>()
  const worker = workflowNodeField(node, "worker")
  if (typeof worker === "string" && worker.length > 0) references.add(worker)
  const gates = workflowNodeField(node, "gates")
  if (gates !== undefined && !Array.isArray(gates)) {
    uncertainty("A lista de gates do pattern é inválida e suas referências de agent não puderam ser resolvidas.")
  }
  for (const gate of Array.isArray(gates) ? gates : []) {
    if (!isRecord(gate)) {
      uncertainty("Um gate inválido não pôde ser inspecionado para referências de agent.")
      continue
    }
    if (typeof gate.agent === "string" && gate.agent.length > 0) {
      references.add(gate.agent)
    }
    if (isRecord(gate.input)) {
      const reviewAgent = gate.input.review_agent
      if (typeof reviewAgent === "string" && reviewAgent.length > 0) {
        references.add(reviewAgent)
      }
    }
  }
  return references
}

function policyIds(
  node: WorkflowSourceNode,
  library: CapabilityCatalog,
  uncertainty: (description: string) => void,
): Set<string> {
  const policies = new Set<string>()
  if (node.type === "built_in") {
    const registration = library.registrations.find(
      (candidate) => candidate.registration_kind === "built_in" && candidate.id === node.registrationId,
    )
    if (registration?.registration_kind !== "built_in") {
      uncertainty(`Built-in ${node.registrationId} não está disponível no catálogo carregado.`)
    } else if (registration.side_effect_policy !== undefined) {
      policies.add(registration.side_effect_policy)
    }
  }
  const declared = workflowNodeField(node, "policies")
  if (declared !== undefined && !Array.isArray(declared)) {
    uncertainty("A lista de policies é inválida e seus efeitos não puderam ser resolvidos.")
  }
  for (const value of Array.isArray(declared) ? declared : []) {
    if (!isRecord(value) || typeof value.uses !== "string" || value.uses.length === 0) {
      uncertainty("Uma policy inválida não pôde ser resolvida contra o catálogo carregado.")
      continue
    }
    policies.add(value.uses)
  }
  return policies
}

export function workflowSideEffectPreview(
  source: JsonValue,
  library: CapabilityCatalog,
  agents: readonly AgentCatalogItem[],
  agentCatalogComplete = false,
): WorkflowSideEffectPreview[] {
  const effects: WorkflowSideEffectPreview[] = []
  const addUncertainty = (nodeId: string, description: string) => {
    effects.push({
      nodeId,
      source: "catalog_uncertainty",
      semantics: "unknown",
      description,
      operationIds: [],
    })
  }
  if (!agentCatalogComplete) {
    addUncertainty("workflow", "O catálogo de agents está parcial ou sua completude não foi confirmada; side effects não podem ser descartados.")
  }
  const visitSource = (candidate: JsonValue, prefix: string): void => {
    const outlineEntries = workflowSourceOutlineEntries(candidate)
    if (!isRecord(candidate) || !Array.isArray(candidate.nodes)) {
      addUncertainty(prefix.length === 0 ? "workflow" : prefix.slice(0, -1), "A sequência de nodes não está projetável; side effects não podem ser descartados.")
      return
    }
    for (const entry of outlineEntries) {
      if (entry.node === undefined) {
        addUncertainty(`${prefix}${entry.label}`, "Node inválido não pôde ser resolvido contra os catálogos carregados.")
      }
    }

    for (const node of workflowSourceNodes(candidate)) {
      const nodeId = `${prefix}${node.id}`
      const uncertainty = (description: string) => addUncertainty(nodeId, description)
      const agentReferences = node.type === "agent"
        ? new Set([node.registrationId])
        : node.type === "pattern"
          ? patternAgentReferences(node, uncertainty)
          : new Set<string>()
      for (const agentId of agentReferences) {
        const agent = agents.find((agentCandidate) => agentCandidate.id === agentId)
        if (agent === undefined) {
          uncertainty(`Agent ${agentId} não está disponível no catálogo carregado.`)
          continue
        }
        if (
          agent.mode === "trusted_local_write" ||
          agent.tools.length > 0 ||
          agent.mcp_servers.length > 0 ||
          agent.subagents.length > 0
        ) {
          effects.push({
            nodeId,
            source: "agent_tools",
            semantics: "unknown",
            description: `Agent ${agent.id} declara modo de escrita, tools, MCP ou subagents; o efeito depende do runtime e da invocation.`,
            operationIds: [],
          })
        }
      }

      for (const policyId of policyIds(node, library, uncertainty)) {
        const policy = library.registrations.find(
          (registration) => registration.registration_kind === "policy" && registration.id === policyId,
        )
        if (policy?.registration_kind !== "policy") {
          uncertainty(`Policy ${policyId} não está disponível no catálogo carregado.`)
          continue
        }
        if (policy.side_effect_semantics === "none") continue
        if (policy.side_effect_semantics === undefined) {
          uncertainty(`Policy ${policy.id} não declara side-effect semantics.`)
          continue
        }
        effects.push({
          nodeId,
          source: "policy",
          semantics: policy.side_effect_semantics,
          description: `Policy ${policy.id}`,
          operationIds: policy.side_effect_operation_ids,
        })
      }

      if (node.type === "loop") {
        visitSource(workflowNodeField(node, "body") ?? null, `${nodeId}.`)
      }
    }
  }
  visitSource(source, "")
  return effects
}
