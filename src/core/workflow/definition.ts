import path from "node:path";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import {
  ArtifactWritePlanSchema,
  assertNoDuplicateArtifactPaths,
  normalizeArtifactWritePlans
} from "./artifact-write-plan.js";
import { builtInStepMetadataRegistry } from "../built-ins/catalog.js";
import type { BuiltInStepRegistryView } from "../built-ins/types.js";
import { loadYamlFile } from "../config/loader.js";
import { assertSafeSegment, isInsideRoot } from "../security/path.js";
import {
  defaultWorkflowSubagentPolicy,
  type WorkflowSubagentPolicy
} from "../agents/subagent-policy.js";
import { ValidationCommandSchema } from "../validation/runner.js";

const NonEmptyStringSchema = z.string().min(1);

const WorkflowExecutionSchema = z
  .object({
    max_concurrency: z.number().int().positive().optional(),
    lock_timeout_ms: z.number().int().positive().optional()
  })
  .strict();

const OptionalExporterConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    required: z.boolean().optional()
  })
  .strict();

const ObservabilityConfigSchema = z
  .object({
    exporters: z
      .object({
        jsonl: OptionalExporterConfigSchema.optional(),
        runtime_log: OptionalExporterConfigSchema.optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .optional();

const SubagentPolicySchema = z
  .object({
    allow_write: z.boolean().optional()
  })
  .strict()
  .optional();

const WorkflowRequirementsSchema = z
  .object({
    repository: z.boolean().optional()
  })
  .strict()
  .optional();

export const WorkflowMetadataSchema = z
  .object({
    id: NonEmptyStringSchema,
    type: z.literal("workflow"),
    mode: z.enum(["read_only", "trusted_local_write"]),
    input_schema: NonEmptyStringSchema,
    output_schema: NonEmptyStringSchema,
    graph: NonEmptyStringSchema,
    execution: WorkflowExecutionSchema.optional(),
    observability: ObservabilityConfigSchema,
    subagent_policy: SubagentPolicySchema,
    requires: WorkflowRequirementsSchema
  })
  .strict();

const BuiltInNodeSchema = z
  .object({
    id: NonEmptyStringSchema,
    type: z.literal("built_in"),
    uses: NonEmptyStringSchema,
    artifacts: z.array(ArtifactWritePlanSchema).optional(),
    input: z.record(z.unknown()).optional(),
    after: z.array(NonEmptyStringSchema).optional()
  })
  .strict();

const RetryPolicySchema = z
  .object({
    enabled: z.boolean().optional(),
    max_attempts: z.number().int().positive().optional(),
    initial_delay_ms: z.number().int().nonnegative().optional(),
    max_delay_ms: z.number().int().positive().optional(),
    backoff_multiplier: z.number().gte(1).optional(),
    jitter: z.enum(["none", "full"]).optional(),
    retryable_error_codes: z
      .array(
        z.enum([
          "transient_transport_failure",
          "timeout",
          "provider_unavailable",
          "rate_limited",
          "permanent_failure",
          "unknown_failure"
        ])
      )
      .optional()
  })
  .strict()
  .optional();

const AgentNodeSchema = z
  .object({
    id: NonEmptyStringSchema,
    type: z.literal("agent"),
    agent: NonEmptyStringSchema,
    output_schema: NonEmptyStringSchema,
    artifacts: z.array(ArtifactWritePlanSchema).optional(),
    retry: RetryPolicySchema,
    input: z.record(z.unknown()).optional(),
    after: z.array(NonEmptyStringSchema).optional()
  })
  .strict();

const ValidationGateSchema = z
  .object({
    id: NonEmptyStringSchema,
    type: z.literal("validation_commands"),
    commands: z.union([
      NonEmptyStringSchema,
      z.array(ValidationCommandSchema)
    ]),
    max_output_bytes: z.union([
      NonEmptyStringSchema,
      z.number().int().positive()
    ])
  })
  .strict();

const GateJsonataExpressionSchema = z
  .object({
    expression: NonEmptyStringSchema
  })
  .strict();

const AgentGateSchema = z
  .object({
    id: NonEmptyStringSchema,
    type: z.literal("agent"),
    agent: NonEmptyStringSchema,
    block_when: GateJsonataExpressionSchema,
    feedback: GateJsonataExpressionSchema.optional(),
    input: z.record(z.unknown()).optional()
  })
  .strict();

const GatedAgentLoopNodeSchema = z
  .object({
    id: NonEmptyStringSchema,
    type: z.literal("gated_agent_loop"),
    agent: NonEmptyStringSchema,
    output_schema: NonEmptyStringSchema,
    artifacts: z.array(ArtifactWritePlanSchema).optional(),
    retry: RetryPolicySchema,
    sandbox: z
      .object({
        type: z.literal("trusted_host_local"),
        cwd: NonEmptyStringSchema,
        env_allowlist: z.array(NonEmptyStringSchema)
      })
      .strict(),
    gates: z.array(
      z.discriminatedUnion("type", [ValidationGateSchema, AgentGateSchema])
    ),
    repair: z
      .object({
        attempts: z.union([
          NonEmptyStringSchema,
          z.number().int().nonnegative()
        ])
      })
      .strict(),
    input: z.record(z.unknown()).optional(),
    after: z.array(NonEmptyStringSchema).optional()
  })
  .strict();

const WorkflowGraphShapeSchema = z
  .object({
    nodes: z
      .array(
        z.discriminatedUnion("type", [
          BuiltInNodeSchema,
          AgentNodeSchema,
          GatedAgentLoopNodeSchema
        ])
      )
      .min(1)
  })
  .strict();

const WorkflowGraphSchema = {
  parse(value: unknown): z.infer<typeof WorkflowGraphShapeSchema> {
    const graph = WorkflowGraphShapeSchema.parse(value);
    const knownStepIds = new Set(graph.nodes.map((node) => node.id));
    const nodes = graph.nodes.map((node) => ({
      ...node,
      artifacts: normalizeArtifactWritePlans(
        node.id,
        node.artifacts,
        knownStepIds
      )
    }));
    assertNoDuplicateArtifactPaths(nodes);

    return { nodes } as z.infer<typeof WorkflowGraphShapeSchema>;
  }
};

export type WorkflowMetadata = z.infer<typeof WorkflowMetadataSchema>;
export type WorkflowExecution = {
  max_concurrency: number;
  lock_timeout_ms?: number;
};
export type WorkflowRequirements = {
  repository: boolean;
};
export type WorkflowObservabilityConfig = {
  exporters: {
    runtime_log: { enabled: boolean; required: boolean };
  };
};
export const defaultWorkflowObservabilityConfig: WorkflowObservabilityConfig = {
  exporters: {
    runtime_log: { enabled: true, required: false }
  }
};
export type WorkflowGraph = z.infer<typeof WorkflowGraphShapeSchema>;
export type WorkflowNode = WorkflowGraph["nodes"][number];

export type WorkflowDefinition = Omit<
  WorkflowMetadata,
  "graph" | "execution"
> & {
  directory: string;
  graph: WorkflowGraph;
  execution: WorkflowExecution;
  requires: WorkflowRequirements;
  observability: WorkflowObservabilityConfig;
  subagent_policy: WorkflowSubagentPolicy;
};

function workflowDefinitionError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

async function safeWorkflowPath(
  directory: string,
  relativePath: string
): Promise<string> {
  const root = path.resolve(directory);
  const resolved = path.resolve(root, relativePath);

  if (!isInsideRoot(root, resolved)) {
    throw workflowDefinitionError(
      `Workflow file path escapes workflow directory: ${relativePath}`,
      "workflow_path_escape"
    );
  }

  const rootReal = await realpath(root);
  const resolvedReal = await realpath(resolved);

  if (!isInsideRoot(rootReal, resolvedReal)) {
    throw workflowDefinitionError(
      `Workflow file path resolves outside workflow directory: ${relativePath}`,
      "workflow_path_escape"
    );
  }

  return resolved;
}

function assertNoDuplicateNodeIds(nodes: WorkflowNode[]): void {
  const seen = new Set<string>();

  for (const node of nodes) {
    if (seen.has(node.id)) {
      throw workflowDefinitionError(
        `Duplicate workflow node id: ${node.id}`,
        "workflow_node_duplicate"
      );
    }

    seen.add(node.id);
  }
}

function assertBuiltInNamesRegistered(
  nodes: WorkflowNode[],
  builtInStepRegistry: BuiltInStepRegistryView
): void {
  for (const node of nodes) {
    if (node.type !== "built_in") {
      continue;
    }

    try {
      builtInStepRegistry.require(node.uses);
    } catch {
      throw workflowDefinitionError(
        `Unsupported built-in step: ${node.uses}`,
        "workflow_built_in_unknown"
      );
    }
  }
}

function assertDependenciesExist(nodes: WorkflowNode[]): void {
  const ids = new Set(nodes.map((node) => node.id));

  for (const node of nodes) {
    for (const dependency of node.after ?? []) {
      if (!ids.has(dependency)) {
        throw workflowDefinitionError(
          `Workflow node ${node.id} depends on unknown node ${dependency}`,
          "workflow_dependency_unknown"
        );
      }
    }
  }
}

function assertAcyclic(nodes: WorkflowNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string): void {
    if (visited.has(id)) {
      return;
    }

    if (visiting.has(id)) {
      throw workflowDefinitionError(
        `Workflow graph contains a cycle at ${id}`,
        "workflow_cycle_detected"
      );
    }

    visiting.add(id);
    const node = byId.get(id);
    for (const dependency of node?.after ?? []) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const node of nodes) {
    visit(node.id);
  }
}

function validateWorkflowGraph(
  graph: WorkflowGraph,
  builtInStepRegistry: BuiltInStepRegistryView,
  workflowMode: WorkflowMetadata["mode"]
): void {
  assertBuiltInNamesRegistered(graph.nodes, builtInStepRegistry);
  assertNoDuplicateNodeIds(graph.nodes);
  assertDependenciesExist(graph.nodes);
  assertAcyclic(graph.nodes);

  if (workflowMode !== "read_only") {
    return;
  }

  for (const node of graph.nodes) {
    if (node.type === "gated_agent_loop") {
      throw workflowDefinitionError(
        `Workflow ${workflowMode} cannot declare gated_agent_loop node: ${node.id}`,
        "workflow_read_only_write_node"
      );
    }

    if (node.type !== "built_in") {
      continue;
    }

    const metadata = builtInStepRegistry.require(node.uses).metadata;
    if (metadata?.implementationLifecycle !== undefined) {
      throw workflowDefinitionError(
        `Workflow ${workflowMode} cannot declare write lifecycle built-in: ${node.uses}`,
        "workflow_read_only_write_node"
      );
    }
  }
}

function normalizeObservabilityConfig(
  config: z.infer<typeof ObservabilityConfigSchema>
): WorkflowObservabilityConfig {
  if (config?.exporters?.jsonl !== undefined) {
    throw new Error("events.jsonl is mandatory and cannot be configured");
  }

  return {
    exporters: {
      runtime_log: {
        ...defaultWorkflowObservabilityConfig.exporters.runtime_log,
        ...config?.exporters?.runtime_log
      }
    }
  };
}

function normalizeSubagentPolicy(
  policy: z.infer<typeof SubagentPolicySchema>
): WorkflowSubagentPolicy {
  return {
    ...defaultWorkflowSubagentPolicy,
    ...(policy?.allow_write === undefined ? {} : { allow_write: policy.allow_write })
  };
}

function normalizeRequirements(
  requirements: z.infer<typeof WorkflowRequirementsSchema>,
  graph: WorkflowGraph,
  builtInStepRegistry: BuiltInStepRegistryView
): WorkflowRequirements {
  const graphRequiresRepository = graph.nodes.some((node) => {
    if (node.type !== "built_in") {
      return false;
    }

    const metadata = builtInStepRegistry.require(node.uses).metadata;
    return (
      metadata?.requiresRepository === true ||
      metadata?.locks?.some((lock) => lock.resource === "repository") === true
    );
  });

  if (requirements?.repository === false && graphRequiresRepository) {
    throw workflowDefinitionError(
      "Workflow disables repository but graph contains repository-sensitive built-ins",
      "workflow_repository_requirement_invalid"
    );
  }

  return {
    repository: requirements?.repository ?? graphRequiresRepository
  };
}

export async function loadWorkflowDefinition(
  workflowsRoot: string,
  workflowId: string,
  options: { builtInStepRegistry?: BuiltInStepRegistryView } = {}
): Promise<WorkflowDefinition> {
  assertSafeSegment(workflowId);
  const directory = path.join(workflowsRoot, workflowId);
  const metadata = await loadYamlFile(
    path.join(directory, "workflow.yaml"),
    WorkflowMetadataSchema
  );

  return await loadWorkflowDefinitionFromMetadata({
    directory,
    metadata,
    workflowId,
    builtInStepRegistry: options.builtInStepRegistry
  });
}

export async function loadWorkflowDefinitionFromMetadata({
  directory,
  metadata,
  workflowId,
  builtInStepRegistry = builtInStepMetadataRegistry
}: {
  directory: string;
  metadata: WorkflowMetadata;
  workflowId: string;
  builtInStepRegistry?: BuiltInStepRegistryView;
}): Promise<WorkflowDefinition> {
  if (metadata.id !== workflowId) {
    throw workflowDefinitionError(
      `Workflow id ${metadata.id} does not match directory ${workflowId}`,
      "workflow_id_mismatch"
    );
  }

  const graphPath = await safeWorkflowPath(directory, metadata.graph);
  const graph = await loadYamlFile(
    graphPath,
    WorkflowGraphSchema
  );
  validateWorkflowGraph(graph, builtInStepRegistry, metadata.mode);

  return {
    ...metadata,
    directory,
    graph,
    execution: {
      max_concurrency: metadata.execution?.max_concurrency ?? 1,
      ...(metadata.execution?.lock_timeout_ms === undefined
        ? {}
        : { lock_timeout_ms: metadata.execution.lock_timeout_ms })
    },
    requires: normalizeRequirements(metadata.requires, graph, builtInStepRegistry),
    observability: normalizeObservabilityConfig(metadata.observability),
    subagent_policy: normalizeSubagentPolicy(metadata.subagent_policy)
  };
}
