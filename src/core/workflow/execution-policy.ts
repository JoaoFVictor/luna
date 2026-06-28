import type { BuiltInStepMetadata } from "../built-ins/types.js";

export type WorkflowExecutionNode = {
  id: string;
  type: "built_in" | "agent" | "pattern";
  uses?: string;
  after?: string[];
  batchExclusionKeys?: readonly string[];
  artifacts?: readonly {
    path: string;
    source: unknown;
    format: "json" | "markdown";
    required: boolean;
  }[];
  [key: string]: unknown;
};

export type WorkflowExecutionLocks = NonNullable<BuiltInStepMetadata["locks"]>;

export type ExecutionPolicyDecision = {
  locks: WorkflowExecutionLocks;
  batchExclusionKeys: string[];
  capturesWorkspace: boolean;
  deferUntilAfterWorkspaceLifecycle: boolean;
  artifactPaths: string[];
};

export type WorkflowExecutionPlanItem<
  TNode extends WorkflowExecutionNode = WorkflowExecutionNode
> = {
  node: TNode;
  decision: ExecutionPolicyDecision;
};

export type WorkflowExecutionBatchPlan<
  TNode extends WorkflowExecutionNode = WorkflowExecutionNode
> = {
  items: WorkflowExecutionPlanItem<TNode>[];
};

export type SelectReadyBatchWithPolicyOptions<
  TNode extends WorkflowExecutionNode = WorkflowExecutionNode
> = {
  ready: TNode[];
  maxConcurrency: number;
  builtInMetadata: (node: TNode) => BuiltInStepMetadata;
};

export type SplitDeferredWorkflowNodesByPolicyOptions<
  TNode extends WorkflowExecutionNode = WorkflowExecutionNode
> = {
  nodes: TNode[];
  builtInMetadata: (node: TNode) => BuiltInStepMetadata;
};

function policyError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function isAgentLike(node: WorkflowExecutionNode): boolean {
  return node.type === "agent";
}

function artifactPaths(node: WorkflowExecutionNode): string[] {
  return (node.artifacts ?? []).map((artifact) => artifact.path);
}

function normalizedMaxConcurrency(maxConcurrency: number): number {
  return Number.isSafeInteger(maxConcurrency) && maxConcurrency > 0
    ? maxConcurrency
    : 1;
}

export function executionPolicyDecisionForNode<
  TNode extends WorkflowExecutionNode
>(
  node: TNode,
  builtInMetadata: (node: TNode) => BuiltInStepMetadata
): ExecutionPolicyDecision {
  const metadata = builtInMetadata(node);
  const locks = metadata.locks ?? [];
  const capturesWorkspace = metadata.capturesWorkspace === true;
  const batchExclusionKeys = [
    ...(isAgentLike(node) ? ["agent_session"] : []),
    ...(node.batchExclusionKeys ?? []),
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

export function selectReadyBatchWithPolicy<
  TNode extends WorkflowExecutionNode
>({
  ready,
  maxConcurrency,
  builtInMetadata
}: SelectReadyBatchWithPolicyOptions<TNode>): WorkflowExecutionBatchPlan<TNode> {
  const items: WorkflowExecutionPlanItem<TNode>[] = [];
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

export function splitDeferredFinalReportNodesByPolicy<
  TNode extends WorkflowExecutionNode
>({
  nodes,
  builtInMetadata
}: SplitDeferredWorkflowNodesByPolicyOptions<TNode>): {
  mainNodes: TNode[];
  deferredNodes: TNode[];
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
