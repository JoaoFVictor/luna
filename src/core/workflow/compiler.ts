import type {
  CapabilityRegistrationIndex,
  CapabilityRegistration
} from "../capabilities/registration-index.js";
import type { PatternExecutionPolicy } from "../capabilities/pattern-registration.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import { analyzeWorkflowGraph } from "./graph-analysis.js";
import type {
  ParsedWorkflowGate,
  ParsedWorkflowPolicy,
  WorkflowDefinition,
  WorkflowNode
} from "./definition-types.js";
import {
  LUNA_RUNTIME_STATE_CHANNELS,
  LUNA_RUNTIME_STATE_SCHEMA_VERSION
} from "../runtime/state.js";
import { isReservedWorkflowNodeId } from "./node-id.js";

export type WorkflowCompilerErrorCode =
  | "workflow_capability_unknown"
  | "workflow_node_id_reserved"
  | "workflow_node_type_unsupported"
  | "workflow_parallel_merge_without_reducer"
  | "workflow_parallel_hitl_unsupported"
  | "workflow_protected_operation_before_approval";

export class WorkflowCompilerError extends Error {
  readonly code: WorkflowCompilerErrorCode;
  readonly path?: string;
  readonly capability?: string;
  readonly nodeId?: string;
  readonly edge?: { readonly from: string; readonly to: string };

  constructor(
    code: WorkflowCompilerErrorCode,
    message: string,
    options: {
      path?: string;
      capability?: string;
      nodeId?: string;
      edge?: { readonly from: string; readonly to: string };
    } = {}
  ) {
    super(message);
    this.name = "WorkflowCompilerError";
    this.code = code;
    this.path = options.path;
    this.capability = options.capability;
    this.nodeId = options.nodeId;
    this.edge = options.edge;
  }
}

export type WorkflowReducer = "object_merge" | "append_only";

export type WorkflowCompilerReducers = {
  readonly steps?: Extract<WorkflowReducer, "object_merge">;
};

export type CompiledWorkflowStateChannel = {
  readonly reducer: WorkflowReducer;
};

export const LUNA_COMPILED_WORKFLOW_STATE_CHANNELS =
  LUNA_RUNTIME_STATE_CHANNELS satisfies Record<string, CompiledWorkflowStateChannel>;

export type CompileWorkflowInput = {
  readonly workflow: WorkflowDefinition;
  readonly registry: CapabilityRegistry;
  readonly reducers?: WorkflowCompilerReducers;
};

export type CompiledWorkflowNodeKind =
  | "built_in"
  | "agent"
  | "pattern"
  | "interrupt"
  | "workflow"
  | "loop";

export type CompiledWorkflowNode = {
  readonly id: string;
  readonly kind: CompiledWorkflowNodeKind;
  readonly yaml_path: string;
  readonly capability_id: string;
  readonly output_schema: unknown;
  readonly can_create_pending_interrupt: boolean;
  readonly execution_policy?: PatternExecutionPolicy;
  readonly composition?: {
    readonly workflow: WorkflowDefinition;
    readonly compiled: CompiledWorkflow;
  };
  readonly loop_body?: readonly CompiledWorkflowNode[];
  readonly source: WorkflowNode;
};

export type CompiledWorkflowEdge = {
  readonly from: string;
  readonly to: string;
};

export type CompiledWorkflow = {
  readonly workflow_id: string;
  readonly workflow_revision: string;
  readonly state_schema_version: string;
  readonly nodes: CompiledWorkflowNode[];
  readonly edges: CompiledWorkflowEdge[];
  readonly state: {
    readonly channels: Record<string, CompiledWorkflowStateChannel>;
  };
};

const START = "__start__";
const END = "__end__";

export function compileWorkflow(input: CompileWorkflowInput): CompiledWorkflow {
  const { workflow, registry } = input;
  const indexes = registry.registrations();
  const analysis = analyzeWorkflowGraph({ nodes: workflow.graph.nodes });
  assertSupportedNodes(workflow.graph.nodes);
  assertParallelMergesHaveReducers(workflow.graph.nodes, input.reducers);

  const compiledNodes = analysis.topological_node_ids.map((nodeId) => {
    const nodeIndex = workflow.graph.nodes.findIndex((node) => node.id === nodeId);
    return compileNode(
      workflow.graph.nodes[nodeIndex],
      nodeIndex,
      indexes,
      registry,
      workflow,
      input.reducers
    );
  });

  assertProtectedOperationsAfterApproval(workflow.graph.nodes, compiledNodes, indexes);
  assertPendingInterruptsAreDependencyOrdered(
    workflow.graph.nodes,
    compiledNodes
  );

  return {
    workflow_id: workflow.id,
    workflow_revision: workflow.revision,
    state_schema_version: LUNA_RUNTIME_STATE_SCHEMA_VERSION,
    nodes: compiledNodes,
    edges: compileEdges(workflow.graph.nodes),
    state: {
      channels: LUNA_COMPILED_WORKFLOW_STATE_CHANNELS
    }
  };
}

function assertSupportedNodes(nodes: readonly WorkflowNode[]): void {
  nodes.forEach((node, index) => {
    if (isReservedWorkflowNodeId(node.id)) {
      throw new WorkflowCompilerError(
        "workflow_node_id_reserved",
        `Workflow node id ${node.id} uses Luna's reserved internal namespace.`,
        { path: `$.nodes[${index}].id` }
      );
    }
    if (
      node.type !== "built_in" &&
      node.type !== "agent" &&
      node.type !== "pattern" &&
      node.type !== "human_gate" &&
      node.type !== "workflow" &&
      node.type !== "loop"
    ) {
      throw new WorkflowCompilerError(
        "workflow_node_type_unsupported",
        `Unsupported workflow node type: ${(node as { type?: unknown }).type}`,
        { path: `$.nodes[${index}].type` }
      );
    }
  });
}

function assertParallelMergesHaveReducers(
  nodes: readonly WorkflowNode[],
  reducers: WorkflowCompilerReducers | undefined
): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  nodes.forEach((node, index) => {
    if (
      hasParallelDependencies(node.after ?? [], byId) &&
      reducers?.steps !== "object_merge"
    ) {
      throw new WorkflowCompilerError(
        "workflow_parallel_merge_without_reducer",
        `Workflow node ${node.id} merges parallel branches without a registered steps reducer.`,
        { path: `$.nodes[${index}].after` }
      );
    }
  });
}

function hasParallelDependencies(
  dependencies: readonly string[],
  byId: ReadonlyMap<string, WorkflowNode>
): boolean {
  for (let leftIndex = 0; leftIndex < dependencies.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < dependencies.length;
      rightIndex += 1
    ) {
      const left = dependencies[leftIndex];
      const right = dependencies[rightIndex];
      const leftDependsOnRight = transitiveDependenciesById(left, byId).has(right);
      const rightDependsOnLeft = transitiveDependenciesById(right, byId).has(left);
      if (!leftDependsOnRight && !rightDependsOnLeft) {
        return true;
      }
    }
  }

  return false;
}

function compileNode(
  node: WorkflowNode,
  nodeIndex: number,
  indexes: CapabilityRegistrationIndex,
  registry: CapabilityRegistry,
  workflow: WorkflowDefinition,
  reducers: WorkflowCompilerReducers | undefined
): CompiledWorkflowNode {
  switch (node.type) {
    case "built_in": {
      const registration = requireRegistration(
        indexes.built_ins,
        node.uses,
        `$.nodes[${nodeIndex}].uses`
      );
      validatePolicies(node.policies ?? [], nodeIndex, indexes);

      return {
        id: node.id,
        kind: "built_in",
        yaml_path: `$.nodes[${nodeIndex}]`,
        capability_id: registration.id,
        output_schema: registration.output_schema,
        can_create_pending_interrupt: false,
        source: node
      };
    }
    case "agent": {
      const capability = registry.workflowNodeCapability("agent");
      if (capability === undefined) {
        throw new WorkflowCompilerError(
          "workflow_capability_unknown",
          "No capability supplies workflow node type agent.",
          { path: `$.nodes[${nodeIndex}].type`, capability: "agent" }
        );
      }
      const schema = requireRegistration(
        indexes.schemas,
        node.output_schema,
        `$.nodes[${nodeIndex}].output_schema`
      );

      return {
        id: node.id,
        kind: "agent",
        yaml_path: `$.nodes[${nodeIndex}]`,
        capability_id: capability.id,
        output_schema: schema.schema,
        can_create_pending_interrupt: false,
        source: node
      };
    }
    case "pattern": {
      const registration = requireRegistration(
        indexes.patterns,
        node.uses,
        `$.nodes[${nodeIndex}].uses`
      );
      validatePolicies(node.policies ?? [], nodeIndex, indexes);
      validateGates(node.gates ?? [], nodeIndex, indexes);

      return {
        id: node.id,
        kind: "pattern",
        yaml_path: `$.nodes[${nodeIndex}]`,
        capability_id: registration.id,
        output_schema: registration.output_schema,
        can_create_pending_interrupt: nodeHasInterruptGate(node.gates ?? [], indexes),
        execution_policy: registration.execution_policy,
        source: node
      };
    }
    case "human_gate": {
      const registration = requireRegistration(
        indexes.gates,
        node.uses,
        `$.nodes[${nodeIndex}].uses`
      );
      validatePolicies(node.policies ?? [], nodeIndex, indexes);

      return {
        id: node.id,
        kind: "interrupt",
        yaml_path: `$.nodes[${nodeIndex}]`,
        capability_id: registration.id,
        output_schema: registration.output_schema,
        can_create_pending_interrupt: true,
        source: node
      };
    }
    case "workflow": {
      const child = workflow.compositions?.[node.workflow];
      if (child === undefined) {
        throw new WorkflowCompilerError(
          "workflow_capability_unknown",
          `Composed workflow ${node.workflow} was not resolved.`,
          { path: `$.nodes[${nodeIndex}].workflow`, capability: `workflow:${node.workflow}` }
        );
      }
      return {
        id: node.id,
        kind: "workflow",
        yaml_path: `$.nodes[${nodeIndex}]`,
        capability_id: `workflow:${child.id}`,
        output_schema: child.output_schema_content,
        can_create_pending_interrupt: false,
        composition: {
          workflow: child,
          compiled: compileWorkflow({ workflow: child, registry, reducers })
        },
        source: node
      };
    }
    case "loop": {
      const analysis = analyzeWorkflowGraph(node.body);
      const body = analysis.topological_node_ids.map((bodyNodeId) => {
        const bodyIndex = node.body.nodes.findIndex(
          (candidate) => candidate.id === bodyNodeId
        );
        const compiled = compileNode(
          node.body.nodes[bodyIndex],
          bodyIndex,
          indexes,
          registry,
          workflow,
          reducers
        );
        return {
          ...compiled,
          yaml_path: `$.nodes[${nodeIndex}].body.nodes[${bodyIndex}]`
        };
      });
      return {
        id: node.id,
        kind: "loop",
        yaml_path: `$.nodes[${nodeIndex}]`,
        capability_id: "workflow.loop",
        output_schema: {},
        can_create_pending_interrupt: true,
        loop_body: body,
        source: node
      };
    }
  }
}

function validatePolicies(
  policies: readonly ParsedWorkflowPolicy[],
  nodeIndex: number,
  indexes: CapabilityRegistrationIndex
): void {
  policies.forEach((policy, policyIndex) => {
    requireRegistration(
      indexes.policies,
      policy.uses,
      `$.nodes[${nodeIndex}].policies[${policyIndex}].uses`
    );
  });
}

function validateGates(
  gates: readonly ParsedWorkflowGate[],
  nodeIndex: number,
  indexes: CapabilityRegistrationIndex
): void {
  gates.forEach((gate, gateIndex) => {
    requireRegistration(
      indexes.gates,
      gate.type,
      `$.nodes[${nodeIndex}].gates[${gateIndex}].type`
    );
  });
}

function nodeHasInterruptGate(
  gates: readonly ParsedWorkflowGate[],
  indexes: CapabilityRegistrationIndex
): boolean {
  return gates.some((gate) => {
    const registration = indexes.gates.get(gate.type);

    return registration !== undefined && registration.interrupt !== "none";
  });
}

function requireRegistration<T extends CapabilityRegistration>(
  registrations: ReadonlyMap<string, T>,
  id: string,
  path: string
): T {
  const registration = registrations.get(id);
  if (registration !== undefined) {
    return registration;
  }

  throw new WorkflowCompilerError(
    "workflow_capability_unknown",
    `Workflow references unknown capability registration ${id}.`,
    { path, capability: id }
  );
}

function compileEdges(nodes: readonly WorkflowNode[]): CompiledWorkflowEdge[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const dependents = new Map<string, string[]>();
  const edges: CompiledWorkflowEdge[] = [];

  for (const node of nodes) {
    if ((node.after ?? []).length === 0) {
      edges.push({ from: START, to: node.id });
    }

    for (const dependency of node.after ?? []) {
      edges.push({ from: dependency, to: node.id });
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), node.id]);
    }
  }

  for (const nodeId of nodeIds) {
    if (!dependents.has(nodeId)) {
      edges.push({ from: nodeId, to: END });
    }
  }

  return edges;
}

function assertPendingInterruptsAreDependencyOrdered(
  nodes: readonly WorkflowNode[],
  compiledNodes: readonly CompiledWorkflowNode[]
): void {
  const interruptNodes = compiledNodes.filter(canCreatePendingInterrupt);
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const interruptNode of interruptNodes) {
    const interruptDependencies = transitiveDependencies(
      interruptNode.source,
      byId
    );
    for (const candidate of compiledNodes) {
      if (candidate.id === interruptNode.id) {
        continue;
      }
      const candidateAfterInterrupt = transitiveDependencies(
        candidate.source,
        byId
      ).has(interruptNode.id);
      const interruptAfterCandidate = interruptDependencies.has(candidate.id);
      if (!candidateAfterInterrupt && !interruptAfterCandidate) {
        throw new WorkflowCompilerError(
          "workflow_parallel_hitl_unsupported",
          "A node that can create a pending interrupt must be dependency-ordered with every other workflow node.",
          { path: `${interruptNode.yaml_path},${candidate.yaml_path}` }
        );
      }
    }
  }
}

function canCreatePendingInterrupt(node: CompiledWorkflowNode): boolean {
  return node.can_create_pending_interrupt;
}

function assertProtectedOperationsAfterApproval(
  nodes: readonly WorkflowNode[],
  compiledNodes: readonly CompiledWorkflowNode[],
  indexes: CapabilityRegistrationIndex
): void {
  const approvalNodeIds = new Set(
    compiledNodes
      .filter((node) => node.kind === "interrupt" || node.kind === "loop")
      .map((node) => node.id)
  );
  if (approvalNodeIds.size === 0) {
    return;
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (node.type === "loop") {
      const protectedBodyIndex = node.body.nodes.findIndex((bodyNode) =>
        isProtectedWriteNode(bodyNode, indexes)
      );
      if (protectedBodyIndex !== -1) {
        const nodeIndex = nodes.findIndex((candidate) => candidate.id === node.id);
        throw new WorkflowCompilerError(
          "workflow_protected_operation_before_approval",
          `Protected loop operation ${node.body.nodes[protectedBodyIndex]!.id} is scheduled before its approval interrupt.`,
          { path: `$.nodes[${nodeIndex}].body.nodes[${protectedBodyIndex}]` }
        );
      }
    }
    if (!isProtectedWriteNode(node, indexes)) {
      continue;
    }
    const ancestors = transitiveDependencies(node, byId);
    if ([...approvalNodeIds].every((approvalId) => !ancestors.has(approvalId))) {
      const nodeIndex = nodes.findIndex((candidate) => candidate.id === node.id);
      throw new WorkflowCompilerError(
        "workflow_protected_operation_before_approval",
        `Protected operation ${node.id} is not scheduled after an approval interrupt.`,
        { path: `$.nodes[${nodeIndex}].after` }
      );
    }
  }
}

function isProtectedWriteNode(
  node: WorkflowNode,
  indexes: CapabilityRegistrationIndex
): boolean {
  if (node.type !== "built_in") {
    return false;
  }

  const registration = indexes.built_ins.get(node.uses);
  const sideEffectPolicy =
    registration?.side_effect_policy === undefined
      ? undefined
      : indexes.policies.get(registration.side_effect_policy);
  if (sideEffectPolicy?.side_effect_semantics === "write") {
    return true;
  }

  return (node.policies ?? []).some(
    (policy) => indexes.policies.get(policy.uses)?.side_effect_semantics === "write"
  );
}

function transitiveDependencies(
  node: WorkflowNode,
  byId: ReadonlyMap<string, WorkflowNode>
): Set<string> {
  const dependencies = new Set<string>();

  for (const dependency of node.after ?? []) {
    for (const nested of transitiveDependenciesById(dependency, byId)) {
      dependencies.add(nested);
    }
  }

  return dependencies;
}

function transitiveDependenciesById(
  id: string,
  byId: ReadonlyMap<string, WorkflowNode>
): Set<string> {
  const dependencies = new Set<string>();

  function visit(currentId: string): void {
    if (dependencies.has(currentId)) {
      return;
    }
    dependencies.add(currentId);

    for (const nested of byId.get(currentId)?.after ?? []) {
      visit(nested);
    }
  }

  visit(id);

  return dependencies;
}
