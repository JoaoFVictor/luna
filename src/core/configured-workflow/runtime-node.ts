import type {
  ParsedArtifactWritePlan,
  ParsedWorkflowGate,
  WorkflowDefinition,
  WorkflowNode
} from "../workflow/definition-types.js";
import type { WorkflowExpression } from "../workflow/expression.js";

export type ConfiguredWorkflowArtifactPlan = {
  path: string;
  source: string;
  format: "json" | "markdown";
  required: boolean;
};

export type ConfiguredWorkflowBuiltInNode = {
  id: string;
  type: "built_in";
  uses: string;
  input?: Record<string, unknown>;
  artifacts?: ConfiguredWorkflowArtifactPlan[];
  after?: string[];
};

export type ConfiguredWorkflowAgentNode = {
  id: string;
  type: "agent";
  agent: string;
  output_schema: string;
  input?: Record<string, unknown>;
  artifacts?: ConfiguredWorkflowArtifactPlan[];
  after?: string[];
  retry?: Record<string, unknown>;
  runtime_requirements?: string[];
};

export type ConfiguredWorkflowValidationGate = {
  id: string;
  type: "validation_commands";
  commands: unknown;
  max_output_bytes: unknown;
  input?: Record<string, unknown>;
};

export type ConfiguredWorkflowAgentGate = {
  id: string;
  type: "agent";
  input?: Record<string, unknown>;
  agent: string;
  decision?: unknown;
  block_when: string | { expression: string };
  feedback?: string | { expression: string };
};

export type ConfiguredWorkflowGatedAgentLoopNode = {
  id: string;
  type: "gated_agent_loop";
  agent: string;
  output_schema: string;
  input?: Record<string, unknown>;
  gates: Array<ConfiguredWorkflowValidationGate | ConfiguredWorkflowAgentGate>;
  repair: Record<string, unknown>;
  artifacts?: ConfiguredWorkflowArtifactPlan[];
  after?: string[];
  retry?: Record<string, unknown>;
  sandbox: {
    type: string;
    cwd: string;
    env_allowlist: string[];
  };
};

export type ConfiguredWorkflowRuntimeNode =
  | ConfiguredWorkflowBuiltInNode
  | ConfiguredWorkflowAgentNode
  | ConfiguredWorkflowGatedAgentLoopNode;

export function projectConfiguredWorkflowRuntimeNodes(
  workflow: WorkflowDefinition
): ConfiguredWorkflowRuntimeNode[] {
  return workflow.graph.nodes.map((node) =>
    projectRuntimeNode(node)
  );
}

function projectRuntimeNode(node: WorkflowNode): ConfiguredWorkflowRuntimeNode {
  const base = {
    id: node.id,
    ...(node.after === undefined ? {} : { after: node.after }),
    ...(node.artifacts === undefined
      ? {}
      : { artifacts: node.artifacts.map(projectArtifact) }),
    ...(!("input" in node) || node.input === undefined
      ? {}
      : { input: projectExpressionValue(node.input) })
  };

  if (node.type === "built_in") {
    return {
      ...base,
      type: "built_in",
      uses: projectBuiltInUse(node.uses)
    };
  }

  if (node.type === "agent") {
    return {
      ...base,
      type: "agent",
      agent: node.agent,
      output_schema: node.output_schema,
      ...(node.retry === undefined ? {} : { retry: node.retry }),
      ...(node.runtime_requirements === undefined
        ? {}
        : { runtime_requirements: node.runtime_requirements })
    };
  }

  if (node.type === "pattern" && node.uses === "quality-gates.gated_agent_loop") {
    if (!node.worker) {
      throw new Error(`Pattern node ${node.id} must declare worker.`);
    }
    return {
      ...base,
      type: "gated_agent_loop",
      agent: node.worker,
      output_schema: `${node.id}_result`,
      gates: (node.gates ?? []).map(projectGate),
      repair: projectExpressionValue(node.repair ?? { attempts: 1 }),
      sandbox: {
        type: "trusted_host_local",
        cwd: "$.workspace.path",
        env_allowlist: []
      }
    };
  }

  throw new Error(`Workflow node ${node.id} cannot be projected to the configured runtime.`);
}

function projectArtifact(artifact: ParsedArtifactWritePlan): ConfiguredWorkflowArtifactPlan {
  return {
    path: artifact.path,
    source: artifact.source.expression,
    format: artifact.format,
    required: artifact.required
  };
}

function projectGate(
  gate: ParsedWorkflowGate
): ConfiguredWorkflowValidationGate | ConfiguredWorkflowAgentGate {
  if (gate.type === "quality-gates.validation_commands") {
    const input = projectExpressionValue(gate.input ?? {});
    return {
      id: gate.id,
      type: "validation_commands",
      commands: input.commands,
      max_output_bytes: input.max_output_bytes
    };
  }

  if (gate.type === "quality-gates.agent_review") {
    const input = projectExpressionValue(gate.input ?? {}, {
      preserveLocalRoots: ["gate"]
    });
    const agent = input.review_agent;
    if (typeof agent !== "string") {
      throw new Error(`Agent gate ${gate.id} must declare input.review_agent.`);
    }
    return {
      id: gate.id,
      type: "agent",
      agent,
      input,
      block_when: projectExpression(gate.block_when ?? { expression: "decision = 'fail'" }),
      ...(gate.feedback === undefined
        ? {}
        : { feedback: projectExpression(gate.feedback) })
    };
  }

  throw new Error(`Gate ${gate.id} cannot be projected to the configured runtime.`);
}

function projectBuiltInUse(uses: string): string {
  const mapped = {
    "runtime.preflight": "preflight",
    "runtime.prepare_worktree": "prepare_worktree",
    "runtime.collect_repo_context": "collect_repo_context",
    "runtime.validate_code_review_findings": "validate_code_review_findings",
    "runtime.final_code_review_report": "final_code_review_report",
    "runtime.prepare_implementation_worktree": "prepare_implementation_worktree",
    "runtime.collect_task_context": "collect_task_context",
    "runtime.record_implementation_validation": "record_implementation_validation",
    "runtime.collect_worktree_diff": "collect_worktree_diff",
    "runtime.commit_changes": "commit_changes",
    "runtime.push_branch": "push_branch",
    "runtime.final_implementation_report": "final_implementation_report",
    "context.collect_context": "collect_context"
  }[uses];
  if (mapped !== undefined) {
    return mapped;
  }
  if (uses === "reports.final_report") {
    return "final_report";
  }
  return uses;
}

function projectExpressionValue(
  value: Record<string, unknown>,
  options: { preserveLocalRoots?: readonly string[] } = {}
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, projectValue(item, options)])
  );
}

function projectValue(
  value: unknown,
  options: { preserveLocalRoots?: readonly string[] }
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => projectValue(item, options));
  }
  if (isWorkflowExpression(value)) {
    if (isPreservedLocalExpression(value, options.preserveLocalRoots ?? [])) {
      return value;
    }
    return value.expression;
  }
  if (typeof value === "object" && value !== null) {
    return projectExpressionValue(value as Record<string, unknown>, options);
  }
  return value;
}

function projectExpression(expression: WorkflowExpression): WorkflowExpression {
  return { expression: expression.expression };
}

function isWorkflowExpression(value: unknown): value is WorkflowExpression {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { expression?: unknown }).expression === "string"
  );
}

function isPreservedLocalExpression(
  value: WorkflowExpression,
  localRoots: readonly string[]
): boolean {
  return localRoots.some(
    (root) =>
      value.expression === `$.${root}` || value.expression.startsWith(`$.${root}.`)
  );
}
