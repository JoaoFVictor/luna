import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  defaultWorkflowSubagentPolicy,
  type WorkflowSubagentPolicy
} from "../agents/subagent-policy.js";
import type { JsonSchemaLike } from "../capabilities/json-schema-types.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import { assertSafeSegment, isInsideRoot } from "../security/path.js";
import { WorkflowDefinitionError } from "./definition-errors.js";
import type { WorkflowDefinitionErrorCode } from "./definition-errors.js";
import {
  assertWorkflowDocument,
  normalizeExecution,
  parseWorkflowYaml,
  readCapabilities,
  readGraph,
  requireString
} from "./definition-schema.js";
import { readWorkflowConfigReference } from "./definition-references.js";
import { defaultWorkflowObservabilityConfig } from "./definition-types.js";
import {
  collectExternalDefinitionDigests,
  computeWorkflowRevision,
  LUNA_WORKFLOW_COMPILER_SCHEMA_VERSION,
  LUNA_WORKFLOW_RUNTIME_SCHEMA_VERSION
} from "./definition-revision.js";
import type { DefinitionDigestResolver } from "./definition-digests.js";
import type {
  LoadWorkflowDefinitionOptions,
  ParsedWorkflowGraph,
  WorkflowDefinition,
  WorkflowMetadata,
  WorkflowRequirements
} from "./definition-types.js";
import {
  validateDeclaredCapabilities,
  validateAgentOutputSchemas,
  validateNodesAgainstCapabilities,
  validateWorkflowCallInputs
} from "./definition-validation.js";
import { analyzeWorkflowGraph } from "./graph-analysis.js";
import {
  assertWorkflowCompositionRequirements,
  resolveWorkflowCompositions
} from "./definition-composition.js";

export {
  LUNA_WORKFLOW_COMPILER_SCHEMA_VERSION,
  LUNA_WORKFLOW_RUNTIME_SCHEMA_VERSION
};
export { WorkflowDefinitionError } from "./definition-errors.js";
export type { WorkflowDefinitionErrorCode } from "./definition-errors.js";
export type { DefinitionDigestResolver } from "./definition-digests.js";
export {
  defaultWorkflowObservabilityConfig,
  WorkflowMetadataSchema
} from "./definition-types.js";
export type {
  ArtifactWritePlan,
  LoadWorkflowDefinitionOptions,
  WorkflowAgentNode,
  WorkflowBuiltInNode,
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowGraph,
  WorkflowHumanGateNode,
  WorkflowCallNode,
  WorkflowMetadata,
  WorkflowNode,
  WorkflowObservabilityConfig,
  WorkflowPatternNode,
  WorkflowRequirements,
} from "./definition-types.js";
export {
  validateWorkflowAgentNodeOutput,
  validateWorkflowNodeOutput
} from "./definition-validation.js";

export async function loadWorkflowDefinition(
  workflowsRoot: string,
  workflowId: string,
  options: LoadWorkflowDefinitionOptions = {}
): Promise<WorkflowDefinition> {
  return await loadWorkflowDefinitionRecursive(
    workflowsRoot,
    workflowId,
    options,
    [],
    new Map()
  );
}

async function loadWorkflowDefinitionRecursive(
  workflowsRoot: string,
  workflowId: string,
  options: LoadWorkflowDefinitionOptions,
  ancestors: readonly string[],
  resolved: Map<string, WorkflowDefinition>
): Promise<WorkflowDefinition> {
  assertSafeSegment(workflowId);
  if (ancestors.includes(workflowId)) {
    throw new WorkflowDefinitionError(
      "workflow_composition_cycle",
      `Workflow composition cycle detected: ${[...ancestors, workflowId].join(" -> ")}.`
    );
  }
  const cached = resolved.get(workflowId);
  if (cached !== undefined) {
    return cached;
  }
  const directory = path.join(workflowsRoot, workflowId);
  const defaultAgentsRoot =
    path.basename(path.resolve(workflowsRoot)) === "workflows"
      ? path.resolve(workflowsRoot, "..", "agents")
      : path.resolve(workflowsRoot, "agents");
  const workflowYaml = await readFile(path.join(directory, "workflow.yaml"), "utf8");

  const definition = await loadWorkflowDefinitionFromMetadata({
    directory,
    metadata: parseWorkflowYaml(workflowYaml) as WorkflowMetadata,
    workflowId,
    workflowYaml,
    agentsRoot: options.agentsRoot ?? defaultAgentsRoot,
    capabilityRegistry: options.capabilityRegistry,
    digestResolver: options.digestResolver,
    compositionResolver: async (childId) => {
      try {
        return await loadWorkflowDefinitionRecursive(
          workflowsRoot,
          childId,
          options,
          [...ancestors, workflowId],
          resolved
        );
      } catch (cause) {
        if (cause instanceof WorkflowDefinitionError) throw cause;
        throw new WorkflowDefinitionError(
          "workflow_external_definition_missing",
          `Unable to resolve composed workflow ${childId}.`,
          { nodeId: childId }
        );
      }
    }
  });
  resolved.set(workflowId, definition);
  return definition;
}

export async function loadWorkflowDefinitionFromMetadata({
  directory,
  metadata,
  workflowId,
  workflowYaml,
  capabilityRegistry,
  digestResolver,
  agentsRoot,
  compositionResolver
}: {
  directory: string;
  metadata: WorkflowMetadata;
  workflowId: string;
  workflowYaml?: string;
  capabilityRegistry?: CapabilityRegistry;
  digestResolver?: DefinitionDigestResolver;
  agentsRoot?: string;
  compositionResolver?: (workflowId: string) => Promise<WorkflowDefinition>;
}): Promise<WorkflowDefinition> {
  const raw = assertWorkflowDocument(metadata);
  const id = requireString(raw.id, "$.id");
  if (id !== workflowId) {
    throw new WorkflowDefinitionError(
      "workflow_id_mismatch",
      `Workflow id ${id} does not match directory ${workflowId}`,
      { path: "$.id" }
    );
  }
  if (raw.type !== "workflow") {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Workflow type must be workflow.",
      { path: "$.type" }
    );
  }

  const inputSchemaPath = requireString(raw.input_schema, "$.input_schema");
  const outputSchemaPath = requireString(raw.output_schema, "$.output_schema");
  const inputSchemaContent = await readJsonSchema(directory, inputSchemaPath);
  const outputSchemaContent = await readJsonSchema(directory, outputSchemaPath);
  const config = await readRuntimeConfig(directory, raw.config);
  const capabilities = readCapabilities(raw.capabilities);
  validateDeclaredCapabilities(capabilities, capabilityRegistry);

  const parsedGraph = readGraph(raw);
  const compositions = await resolveWorkflowCompositions({
    graph: parsedGraph,
    parentId: id,
    parentMode: normalizeMode(raw.mode),
    resolver: compositionResolver
  });
  const requirements = normalizeRequirements(raw.requires);
  assertWorkflowCompositionRequirements({
    parentId: id,
    requirements,
    compositions
  });
  const nodeIds = new Set(parsedGraph.nodes.map((node) => node.id));
  validateNodesAgainstCapabilities(
    parsedGraph.nodes,
    capabilities,
    nodeIds,
    capabilityRegistry
  );
  validateWorkflowCallInputs(parsedGraph.nodes, compositions);
  await validateAgentOutputSchemas(
    parsedGraph.nodes,
    agentsRoot ?? path.resolve(directory, "..", "..", "agents"),
    capabilities,
    capabilityRegistry
  );
  analyzeParsedGraph(parsedGraph);

  const externalDefinitionDigests = await collectExternalDefinitionDigests(
    parsedGraph.nodes,
    digestResolver,
    compositions
  );
  const revision = computeWorkflowRevision({
    canonicalWorkflow:
      workflowYaml === undefined ? raw : parseWorkflowYaml(workflowYaml),
    inputSchemaContent,
    outputSchemaContent,
    configSchemaContent: config?.schema_content,
    capabilities,
    externalDefinitionDigests,
    capabilityRegistry
  });

  return {
    id,
    type: "workflow",
    mode: normalizeMode(raw.mode),
    directory,
    input_schema: inputSchemaPath,
    output_schema: outputSchemaPath,
    input_schema_content: inputSchemaContent,
    output_schema_content: outputSchemaContent,
    ...(config === undefined ? {} : { config }),
    capabilities,
    graph: parsedGraph,
    revision,
    external_definition_digests: externalDefinitionDigests,
    execution: normalizeExecution(raw.execution),
    requires: requirements,
    observability: normalizeObservability(raw.observability),
    subagent_policy: normalizeSubagentPolicy(raw.subagent_policy),
    ...(Object.keys(compositions).length === 0 ? {} : { compositions })
  };
}

async function readRuntimeConfig(
  directory: string,
  value: unknown
): Promise<WorkflowDefinition["config"] | undefined> {
  const reference = readWorkflowConfigReference(value);
  if (reference === undefined) {
    return undefined;
  }
  return {
    ...reference,
    schema_content: await readJsonSchema(directory, reference.schema)
  };
}

async function readJsonSchema(
  directory: string,
  relativePath: string
): Promise<JsonSchemaLike> {
  const schemaPath = await safeWorkflowPath(directory, relativePath);
  try {
    return JSON.parse(await readFile(schemaPath, "utf8")) as JsonSchemaLike;
  } catch (cause) {
    if ((cause as { code?: unknown }).code === "ENOENT") {
      throw new WorkflowDefinitionError(
        "workflow_schema_missing",
        `Workflow schema is missing: ${relativePath}`
      );
    }
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      `Workflow schema is invalid JSON: ${relativePath}`
    );
  }
}

async function safeWorkflowPath(
  directory: string,
  relativePath: string
): Promise<string> {
  const root = path.resolve(directory);
  const resolved = path.resolve(root, relativePath);
  if (!isInsideRoot(root, resolved)) {
    throw new WorkflowDefinitionError(
      "workflow_path_escape",
      `Workflow file path escapes workflow directory: ${relativePath}`
    );
  }

  try {
    const rootReal = await realpath(root);
    const resolvedReal = await realpath(resolved);
    if (!isInsideRoot(rootReal, resolvedReal)) {
      throw new WorkflowDefinitionError(
        "workflow_path_escape",
        `Workflow file path resolves outside workflow directory: ${relativePath}`
      );
    }
  } catch (cause) {
    if ((cause as { code?: unknown }).code === "ENOENT") {
      throw new WorkflowDefinitionError(
        "workflow_schema_missing",
        `Workflow referenced file does not exist: ${relativePath}`
      );
    }
    throw cause;
  }

  return resolved;
}

function analyzeParsedGraph(graph: ParsedWorkflowGraph): void {
  try {
    analyzeWorkflowGraph(graph);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause) {
      throw new WorkflowDefinitionError(
        (cause as { code: WorkflowDefinitionErrorCode }).code,
        cause.message,
        {
          path: (cause as { path?: string }).path,
          nodeId: (cause as { nodeId?: string }).nodeId,
          edge: (cause as {
            edge?: { readonly from: string; readonly to: string };
          }).edge
        }
      );
    }
    throw cause;
  }
}

function normalizeRequirements(value: unknown): WorkflowRequirements {
  if (value === undefined) {
    return { repository: false };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Workflow requires must be an object.",
      { path: "$.requires" }
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "repository") {
      throw new WorkflowDefinitionError(
        "workflow_unknown_field",
        `Unknown workflow field ${key} at $.requires.`,
        { path: `$.requires.${key}` }
      );
    }
  }
  if (record.repository !== undefined && typeof record.repository !== "boolean") {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Workflow requires.repository must be boolean.",
      { path: "$.requires.repository" }
    );
  }
  return { repository: record.repository === true };
}

function normalizeSubagentPolicy(value: unknown): WorkflowSubagentPolicy {
  if (value === undefined) {
    return defaultWorkflowSubagentPolicy;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Workflow subagent_policy must be an object.",
      { path: "$.subagent_policy" }
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "allow_write") {
      throw new WorkflowDefinitionError(
        "workflow_unknown_field",
        `Unknown workflow field ${key} at $.subagent_policy.`,
        { path: `$.subagent_policy.${key}` }
      );
    }
  }
  if (record.allow_write !== undefined && typeof record.allow_write !== "boolean") {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Workflow subagent_policy.allow_write must be boolean.",
      { path: "$.subagent_policy.allow_write" }
    );
  }
  return {
    ...defaultWorkflowSubagentPolicy,
    ...(record as Partial<WorkflowSubagentPolicy>)
  };
}

function normalizeMode(value: unknown): "read_only" | "trusted_local_write" {
  if (value === undefined || value === "read_only") {
    return "read_only";
  }
  if (value === "trusted_local_write") {
    return "trusted_local_write";
  }
  throw new WorkflowDefinitionError(
    "workflow_schema_invalid",
    "Workflow mode must be read_only or trusted_local_write.",
    { path: "$.mode" }
  );
}

function normalizeObservability(value: unknown): WorkflowDefinition["observability"] {
  if (value === undefined) {
    return defaultWorkflowObservabilityConfig;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Workflow observability must be an object.",
      { path: "$.observability" }
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "exporters") {
      throw new WorkflowDefinitionError(
        "workflow_unknown_field",
        `Unknown workflow field ${key} at $.observability.`,
        { path: `$.observability.${key}` }
      );
    }
  }
  const exporters = assertObjectLike(record.exporters ?? {}, "$.observability.exporters");
  for (const key of Object.keys(exporters)) {
    if (key !== "runtime_log") {
      throw new WorkflowDefinitionError(
        "workflow_unknown_field",
        `Unknown workflow field ${key} at $.observability.exporters.`,
        { path: `$.observability.exporters.${key}` }
      );
    }
  }
  const runtimeLog = assertObjectLike(
    exporters.runtime_log ?? defaultWorkflowObservabilityConfig.exporters.runtime_log,
    "$.observability.exporters.runtime_log"
  );
  for (const key of Object.keys(runtimeLog)) {
    if (key !== "enabled" && key !== "required") {
      throw new WorkflowDefinitionError(
        "workflow_unknown_field",
        `Unknown workflow field ${key} at $.observability.exporters.runtime_log.`,
        { path: `$.observability.exporters.runtime_log.${key}` }
      );
    }
  }
  if (runtimeLog.enabled !== undefined && typeof runtimeLog.enabled !== "boolean") {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Workflow observability runtime_log.enabled must be boolean.",
      { path: "$.observability.exporters.runtime_log.enabled" }
    );
  }
  if (runtimeLog.required !== undefined && typeof runtimeLog.required !== "boolean") {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Workflow observability runtime_log.required must be boolean.",
      { path: "$.observability.exporters.runtime_log.required" }
    );
  }
  return {
    exporters: {
      runtime_log: {
        enabled:
          runtimeLog.enabled ?? defaultWorkflowObservabilityConfig.exporters.runtime_log.enabled,
        required:
          runtimeLog.required ?? defaultWorkflowObservabilityConfig.exporters.runtime_log.required
      }
    }
  };
}

function assertObjectLike(value: unknown, yamlPath: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      `Expected object at ${yamlPath}.`,
      { path: yamlPath }
    );
  }
  return value as Record<string, unknown>;
}
