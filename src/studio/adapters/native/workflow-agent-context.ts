import type { AgentMetadata } from "../../../capabilities/agents/agent-definition.js";
import type { WorkflowDefinition } from "../../../core/workflow/definition.js";

export type StudioWorkflowAgentContextIssue = {
  readonly agentId: string;
  readonly nodeId: string;
  readonly nodeIndex: number;
  readonly fieldPath: string;
};

type AgentContextLoader = (agentId: string) => Promise<Pick<AgentMetadata, "context">>;

type AgentParticipant = {
  readonly agentId: string;
  readonly node: WorkflowDefinition["graph"]["nodes"][number];
  readonly nodeIndex: number;
  readonly input: Record<string, unknown> | undefined;
  readonly fieldPath: string;
};

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nodeParticipants(
  node: WorkflowDefinition["graph"]["nodes"][number],
  nodeIndex: number
): AgentParticipant[] {
  if (node.type === "agent") {
    return [{
      agentId: node.agent,
      node,
      nodeIndex,
      input: node.input,
      fieldPath: `$.nodes[${nodeIndex}].input.context`
    }];
  }
  if (node.type !== "pattern") {
    return [];
  }

  const participants: AgentParticipant[] = node.worker === undefined
    ? []
    : [{
        agentId: node.worker,
        node,
        nodeIndex,
        input: node.input,
        fieldPath: `$.nodes[${nodeIndex}].input.context`
      }];
  for (const [gateIndex, gate] of (node.gates ?? []).entries()) {
    const agentId = gate.input?.review_agent;
    if (typeof agentId !== "string" || agentId === "") continue;
    participants.push({
      agentId,
      node,
      nodeIndex,
      input: gate.input,
      fieldPath: `$.nodes[${nodeIndex}].gates[${gateIndex}].input.context`
    });
  }
  return participants;
}

function collectorIncludesAgent(
  node: WorkflowDefinition["graph"]["nodes"][number],
  agentId: string
): boolean {
  if (node.type !== "built_in" || node.uses !== "context.collect_context") {
    return false;
  }
  const agents = objectValue(node.input)?.agents;
  return Array.isArray(agents) && agents.includes(agentId);
}

function inputReferencesCollector(
  input: Record<string, unknown> | undefined,
  collectorId: string
): boolean {
  const context = objectValue(objectValue(input)?.context);
  const expression = context?.expression;
  return expression === `$.steps.${collectorId}`;
}

function transitivelyDependsOn(
  node: WorkflowDefinition["graph"]["nodes"][number],
  dependencyId: string,
  nodesById: ReadonlyMap<string, WorkflowDefinition["graph"]["nodes"][number]>,
  visited: Set<string> = new Set()
): boolean {
  for (const parentId of node.after ?? []) {
    if (parentId === dependencyId) return true;
    if (visited.has(parentId)) continue;
    visited.add(parentId);
    const parent = nodesById.get(parentId);
    if (
      parent !== undefined &&
      transitivelyDependsOn(parent, dependencyId, nodesById, visited)
    ) {
      return true;
    }
  }
  return false;
}

export async function findStudioWorkflowAgentContextIssue(
  workflow: WorkflowDefinition,
  loadAgent: AgentContextLoader
): Promise<StudioWorkflowAgentContextIssue | undefined> {
  const participants = workflow.graph.nodes.flatMap(nodeParticipants);
  const definitions = new Map(
    await Promise.all(
      [...new Set(participants.map(({ agentId }) => agentId))].map(
        async (agentId) => [agentId, await loadAgent(agentId)] as const
      )
    )
  );
  const nodesById = new Map(workflow.graph.nodes.map((node) => [node.id, node]));

  for (const { agentId, node, nodeIndex, input, fieldPath } of participants) {
    if ((definitions.get(agentId)?.context?.files.length ?? 0) === 0) continue;
    const bound = workflow.graph.nodes.some(
      (collector) =>
        collectorIncludesAgent(collector, agentId) &&
        inputReferencesCollector(input, collector.id) &&
        transitivelyDependsOn(node, collector.id, nodesById)
    );
    if (!bound) return { agentId, nodeId: node.id, nodeIndex, fieldPath };
  }
  return undefined;
}
