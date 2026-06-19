import path from "node:path";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { loadYamlFile } from "./config-loader.js";
import { assertSafeSegment, isInsideRoot } from "./path-security.js";

const NonEmptyStringSchema = z.string().min(1);

const WorkflowMetadataSchema = z
  .object({
    id: NonEmptyStringSchema,
    type: z.literal("workflow"),
    mode: z.literal("git_managed_read_only"),
    input_schema: NonEmptyStringSchema,
    output_schema: NonEmptyStringSchema,
    graph: NonEmptyStringSchema,
    artifacts: z
      .object({
        root_namespace: NonEmptyStringSchema.optional()
      })
      .optional()
  })
  .strict();

const BuiltInNodeSchema = z
  .object({
    id: NonEmptyStringSchema,
    type: z.literal("built_in"),
    uses: z.enum([
      "preflight",
      "prepare_worktree",
      "collect_repo_context",
      "validate_code_review_findings",
      "final_code_review_report"
    ]),
    artifact: z.union([NonEmptyStringSchema, z.record(NonEmptyStringSchema)]).optional(),
    input: z.record(z.unknown()).optional(),
    after: z.array(NonEmptyStringSchema).optional()
  })
  .strict();

const AgentNodeSchema = z
  .object({
    id: NonEmptyStringSchema,
    type: z.literal("agent"),
    agent: NonEmptyStringSchema,
    output_schema: NonEmptyStringSchema,
    artifact: NonEmptyStringSchema.optional(),
    input: z.record(z.unknown()).optional(),
    after: z.array(NonEmptyStringSchema).optional()
  })
  .strict();

const WorkflowGraphSchema = z
  .object({
    nodes: z.array(z.discriminatedUnion("type", [BuiltInNodeSchema, AgentNodeSchema])).min(1)
  })
  .strict();

export type WorkflowMetadata = z.infer<typeof WorkflowMetadataSchema>;
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;
export type WorkflowNode = WorkflowGraph["nodes"][number];

export type WorkflowDefinition = Omit<WorkflowMetadata, "graph"> & {
  directory: string;
  graph: WorkflowGraph;
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

function validateWorkflowGraph(graph: WorkflowGraph): void {
  assertNoDuplicateNodeIds(graph.nodes);
  assertDependenciesExist(graph.nodes);
  assertAcyclic(graph.nodes);
}

export async function loadWorkflowDefinition(
  workflowsRoot: string,
  workflowId: string
): Promise<WorkflowDefinition> {
  assertSafeSegment(workflowId);
  const directory = path.join(workflowsRoot, workflowId);
  const metadata = await loadYamlFile(
    path.join(directory, "workflow.yaml"),
    WorkflowMetadataSchema
  );

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
  validateWorkflowGraph(graph);

  return {
    ...metadata,
    directory,
    graph
  };
}
