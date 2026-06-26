import type {
  CompiledWorkflow,
  CompiledWorkflowNode
} from "./compiler.js";

export function readyNodes(
  nodes: readonly CompiledWorkflowNode[],
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  pending: ReadonlySet<string>,
  completed: ReadonlySet<string>
): CompiledWorkflowNode[] {
  return nodes.filter((node) => {
    if (!pending.has(node.id)) {
      return false;
    }

    return [...(dependencies.get(node.id) ?? [])]
      .every((dependency) => completed.has(dependency));
  });
}

export function dependenciesByNode(
  compiled: CompiledWorkflow,
  nodeIds: ReadonlySet<string>
): Map<string, Set<string>> {
  const dependencies = new Map<string, Set<string>>();
  for (const node of compiled.nodes) {
    if (nodeIds.has(node.id)) {
      dependencies.set(node.id, new Set());
    }
  }
  for (const edge of compiled.edges) {
    if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) {
      dependencies.get(edge.to)?.add(edge.from);
    }
  }

  return dependencies;
}

export function terminalWorkflowNodes(
  compiled: CompiledWorkflow
): CompiledWorkflowNode[] {
  const nodeIds = new Set(compiled.nodes.map((node) => node.id));
  const nonTerminal = new Set(
    compiled.edges
      .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
      .map((edge) => edge.from)
  );

  return compiled.nodes.filter((node) => !nonTerminal.has(node.id));
}
