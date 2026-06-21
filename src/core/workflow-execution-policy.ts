import type { BuiltInStepMetadata } from "./built-ins/types.js";
import type { WorkflowNode } from "./workflow-definition.js";

export type WorkflowExecutionLocks = NonNullable<BuiltInStepMetadata["locks"]>;

export type ExecutionPolicyDecision = {
  locks: WorkflowExecutionLocks;
  batchExclusionKeys: string[];
  capturesWorkspace: boolean;
  deferUntilAfterWorkspaceLifecycle: boolean;
  artifactPaths: string[];
};

export type WorkflowExecutionPlanItem = {
  node: WorkflowNode;
  decision: ExecutionPolicyDecision;
};

export type WorkflowExecutionBatchPlan = {
  items: WorkflowExecutionPlanItem[];
};

export type SelectReadyBatchWithPolicyOptions = {
  ready: WorkflowNode[];
  maxConcurrency: number;
  builtInMetadata: (node: WorkflowNode) => BuiltInStepMetadata;
};

export type SplitDeferredWorkflowNodesByPolicyOptions = {
  nodes: WorkflowNode[];
  builtInMetadata: (node: WorkflowNode) => BuiltInStepMetadata;
};

function policyError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function isAgentLike(node: WorkflowNode): boolean {
  return node.type === "agent" || node.type === "agent_loop";
}

function artifactPaths(node: WorkflowNode): string[] {
  return (node.artifacts ?? []).map((artifact) => artifact.path);
}

function normalizedMaxConcurrency(maxConcurrency: number): number {
  return Number.isSafeInteger(maxConcurrency) && maxConcurrency > 0
    ? maxConcurrency
    : 1;
}

export function executionPolicyDecisionForNode(
  node: WorkflowNode,
  builtInMetadata: (node: WorkflowNode) => BuiltInStepMetadata
): ExecutionPolicyDecision {
  const metadata = builtInMetadata(node);
  const locks = metadata.locks ?? [];
  const capturesWorkspace = metadata.capturesWorkspace === true;
  const batchExclusionKeys = [
    ...(isAgentLike(node) ? ["agent_session"] : []),
    ...(capturesWorkspace ? ["workspace_capture"] : [])
  ];

  return {
    locks,
    batchExclusionKeys,
    capturesWorkspace,
    deferUntilAfterWorkspaceLifecycle:
      metadata.deferredLifecycle === "final_report",
    artifactPaths: artifactPaths(node)
  };
}

export function selectReadyBatchWithPolicy({
  ready,
  maxConcurrency,
  builtInMetadata
}: SelectReadyBatchWithPolicyOptions): WorkflowExecutionBatchPlan {
  const items: WorkflowExecutionPlanItem[] = [];
  const selectedArtifactPaths = new Set<string>();
  const selectedBatchExclusionKeys = new Set<string>();
  const concurrency = normalizedMaxConcurrency(maxConcurrency);

  for (const node of ready) {
    if (items.length >= concurrency) {
      break;
    }

    const decision = executionPolicyDecisionForNode(node, builtInMetadata);
    const collidesWithArtifact = decision.artifactPaths.some((path) =>
      selectedArtifactPaths.has(path)
    );

    if (collidesWithArtifact) {
      continue;
    }
    if (
      decision.batchExclusionKeys.some((key) =>
        selectedBatchExclusionKeys.has(key)
      )
    ) {
      continue;
    }

    items.push({ node, decision });
    for (const path of decision.artifactPaths) {
      selectedArtifactPaths.add(path);
    }
    for (const key of decision.batchExclusionKeys) {
      selectedBatchExclusionKeys.add(key);
    }
  }

  return { items };
}

export function splitDeferredFinalReportNodesByPolicy({
  nodes,
  builtInMetadata
}: SplitDeferredWorkflowNodesByPolicyOptions): {
  mainNodes: WorkflowNode[];
  deferredNodes: WorkflowNode[];
} {
  const decisions = new Map(
    nodes.map((node) => [
      node.id,
      executionPolicyDecisionForNode(node, builtInMetadata)
    ])
  );
  const deferredIds = new Set(
    nodes
      .filter(
        (node) =>
          decisions.get(node.id)?.deferUntilAfterWorkspaceLifecycle === true
      )
      .map((node) => node.id)
  );

  for (const node of nodes) {
    if (deferredIds.has(node.id)) {
      continue;
    }

    for (const dependency of node.after ?? []) {
      if (deferredIds.has(dependency)) {
        throw policyError(
          "Non-deferred node depends on deferred workflow node",
          "workflow_deferred_dependency_invalid"
        );
      }
    }
  }

  return {
    mainNodes: nodes.filter((node) => !deferredIds.has(node.id)),
    deferredNodes: nodes.filter((node) => deferredIds.has(node.id))
  };
}
