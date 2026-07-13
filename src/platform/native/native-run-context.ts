import { randomBytes } from "node:crypto";
import path from "node:path";
import { loadAgentDefinition } from "../../capabilities/agents/agent-loader.js";
import { loadWorkflowDefinitionWithAgentDigests } from "../../capabilities/agents/workflow-definition-loader.js";
import { capabilityManifest } from "../../core/capabilities/manifest.js";
import type { JsonSchemaLike } from "../../core/capabilities/json-schema-types.js";
import { createCapabilityRegistry } from "../../core/capabilities/registry.js";
import { loadYamlFile, loadYamlJsonSchemaFile } from "../../core/config/loader.js";
import {
  AppConfigSchema,
  RepositoriesConfigSchema,
  type AppConfig,
  type RepositoryConfig
} from "../../core/config/schemas.js";
import { createRunIdentity } from "../../core/invocation/run-identity.js";
import { InvocationSchema } from "../../core/router/invocation.js";
import {
  assertCheckpointJsonValue,
  type JsonValue
} from "../../core/runtime/json.js";
import type { RunHandle } from "../../core/runtime/run-handle.js";
import { runtimeError } from "../../core/runtime/errors.js";
import { isInsideRoot } from "../../core/security/path.js";
import { compileWorkflow, type CompiledWorkflow } from "../../core/workflow/compiler.js";
import type { WorkflowDefinition } from "../../core/workflow/definition-types.js";
import { scopeWorkflowDefinition } from "../../core/workflow/execution-scope.js";
import { planPrecompletedWorkflowExecution } from "../../core/workflow/precompleted-execution.js";
import { assertWorkflowExecutionRequirements } from "../../core/workflow/execution-policy.js";
import { workflowExecutionPlanPolicyNode } from "../../core/workflow/execution-plan.js";
import { resolveRepository } from "../../core/workflow/workspace-resolver.js";
import type { RuntimeCompositionConfig } from "../../runtime/composition/app-config.js";
import type {
  NativeWorkflowRunInput
} from "../../runtime/composition/target-executor.js";
import {
  nativeLunaPlatformRegistrations,
  type NativeLunaPlatformRegistrations
} from "./native-platform-registrations.js";
import {
  createNativeProviderBuiltIns,
  nativeBuiltInMetadata
} from "./native-built-ins.js";

export type NativeCompiledWorkflow = {
  readonly workflow: WorkflowDefinition;
  readonly compiled: CompiledWorkflow;
};

export class NativePrecompletedStepNodeError extends Error {
  readonly nodeId: string;

  constructor(nodeId: string) {
    super("Precompleted steps reference a node outside the effective workflow scope");
    this.name = "NativePrecompletedStepNodeError";
    this.nodeId = nodeId;
  }
}

export type NativeRunContext = {
  readonly app: AppConfig;
  readonly agentsRoot: string;
  readonly definitionConfigRoot: string;
  readonly workflow: WorkflowDefinition;
  readonly nativeWorkflow: NativeCompiledWorkflow;
  readonly repository?: RepositoryConfig;
  readonly run: RunHandle;
  readonly runtimeConfig: RuntimeCompositionConfig;
};

export type NativeRunContextDependencies = {
  readonly platform?: Pick<
    NativeLunaPlatformRegistrations,
    | "capabilityRegistry"
    | "capabilityManifests"
    | "workflowBuiltIns"
    | "taskProviderBuiltIns"
  >;
};

export async function loadNativeRunContext(
  {
    invocation,
    target,
    projectRoot,
    configRoot,
    definitionRoots,
    run: preallocatedRun,
    executionScope,
    precompleted_steps: precompletedSteps
  }: NativeWorkflowRunInput,
  dependencies: NativeRunContextDependencies = {}
): Promise<NativeRunContext> {
  const platform = dependencies.platform ?? nativeLunaPlatformRegistrations;
  const definitionProjectRoot =
    definitionRoots?.projectRoot ?? projectRoot;
  const definitionConfigRoot =
    definitionRoots?.configRoot ?? configRoot;
  const app = await loadYamlFile(
    path.join(definitionConfigRoot, "app.yaml"),
    AppConfigSchema
  );
  const repositories = await loadYamlFile(
    path.join(definitionConfigRoot, "repositories.yaml"),
    RepositoriesConfigSchema
  );
  const agentsRoot = path.join(definitionProjectRoot, "agents");
  const installedWorkflow = await loadNativeWorkflowDefinition({
    projectRoot: definitionProjectRoot,
    workflowId: target.id,
    platform
  });
  const workflow = scopeWorkflowDefinition(
    installedWorkflow,
    executionScope ?? { kind: "workflow" },
    new Set(Object.keys(precompletedSteps ?? {}))
  );
  const scopedNodeIds = new Set(workflow.graph.nodes.map((node) => node.id));
  for (const nodeId of Object.keys(precompletedSteps ?? {})) {
    if (!scopedNodeIds.has(nodeId)) {
      throw new NativePrecompletedStepNodeError(nodeId);
    }
  }
  const nativeWorkflow = await compileNativeWorkflow({
    workflow,
    agentsRoot,
    platform,
    precompletedNodeIds: new Set(Object.keys(precompletedSteps ?? {}))
  });
  const repository = workflow.requires.repository
    ? resolveRepository(InvocationSchema.parse(invocation), repositories.repositories)
    : undefined;
  const run = preallocatedRun ?? createRunIdentity(
    { ...InvocationSchema.parse(invocation), target },
    {
      attempt: 1,
      date: new Date(),
      workflowId: workflow.id,
      nonce: randomBytes(4).toString("hex")
    }
  );
  assertNativeRunHandle(run, workflow.id);

  return {
    app,
    agentsRoot,
    definitionConfigRoot,
    workflow: nativeWorkflow.workflow,
    nativeWorkflow,
    repository,
    run,
    runtimeConfig: runtimeCompositionConfig(app, projectRoot)
  };
}

function assertNativeRunHandle(run: RunHandle, workflowId: string): void {
  assertCheckpointJsonValue(run);
  if (
    typeof run.run_id !== "string" ||
    run.run_id.length === 0 ||
    typeof run.workflow_id !== "string" ||
    run.workflow_id !== workflowId ||
    !Number.isSafeInteger(run.attempt) ||
    run.attempt < 1 ||
    typeof run.started_at !== "string" ||
    !Number.isFinite(Date.parse(run.started_at))
  ) {
    throw runtimeError(
      "Preallocated native run identity is invalid",
      "runtime_state_invalid",
      { details: { workflow_id: workflowId } }
    );
  }
}

export async function loadNativeWorkflowDefinition({
  projectRoot,
  workflowId,
  platform = nativeLunaPlatformRegistrations
}: {
  readonly projectRoot: string;
  readonly workflowId: string;
  readonly platform?: Pick<NativeLunaPlatformRegistrations, "capabilityRegistry">;
}): Promise<WorkflowDefinition> {
  return await loadWorkflowDefinitionWithAgentDigests(
    path.join(projectRoot, "workflows"),
    workflowId,
    {
      agentsRoot: path.join(projectRoot, "agents"),
      capabilityRegistry: platform.capabilityRegistry
    }
  );
}

export async function compileNativeWorkflow({
  workflow,
  agentsRoot,
  platform = nativeLunaPlatformRegistrations,
  precompletedNodeIds = new Set()
}: {
  readonly workflow: WorkflowDefinition;
  readonly agentsRoot: string;
  readonly precompletedNodeIds?: ReadonlySet<string>;
  readonly platform?: Pick<
    NativeLunaPlatformRegistrations,
    | "capabilityRegistry"
    | "capabilityManifests"
    | "workflowBuiltIns"
    | "taskProviderBuiltIns"
  >;
}): Promise<NativeCompiledWorkflow> {
  const executionPlan = planPrecompletedWorkflowExecution(
    workflow,
    precompletedNodeIds
  );
  const effectiveWorkflow = executionPlan.workflow;
  const schemaRegistrations: Record<
    string,
    { readonly id: string; readonly schema: JsonSchemaLike }
  > = {};
  const compiledWorkflow = await materializeNativeAgentSchemas(
    effectiveWorkflow,
    agentsRoot,
    platform.capabilityRegistry,
    schemaRegistrations
  );
  const registry =
    Object.keys(schemaRegistrations).length === 0
      ? platform.capabilityRegistry
      : createCapabilityRegistry([
          ...platform.capabilityManifests,
          capabilityManifest({
            id: "workflow-agent-schemas",
            kind: "execution",
            version: effectiveWorkflow.revision,
            schemas: schemaRegistrations
          })
        ]);

  const compiled = compileWorkflow({
    workflow: compiledWorkflow,
    registry,
    reducers: { steps: "object_merge" }
  });
  const providerBuiltIns = createNativeProviderBuiltIns({
    workflowBuiltIns: platform.workflowBuiltIns,
    taskProviderBuiltIns: platform.taskProviderBuiltIns,
    capabilityRegistry: platform.capabilityRegistry
  });
  assertWorkflowExecutionRequirements({
    nodes: executableCompiledTree(compiled, executionPlan.executable_node_ids)
      .map(workflowExecutionPlanPolicyNode),
    requiresRepository: effectiveWorkflow.requires.repository,
    builtInMetadata: (node) =>
      nativeBuiltInMetadata(providerBuiltIns.builtInStepRegistry, node.compiled)
  });

  return { workflow: compiledWorkflow, compiled };
}

async function materializeNativeAgentSchemas(
  workflow: WorkflowDefinition,
  agentsRoot: string,
  capabilityRegistry: NativeLunaPlatformRegistrations["capabilityRegistry"],
  schemaRegistrations: Record<
    string,
    { readonly id: string; readonly schema: JsonSchemaLike }
  >
): Promise<WorkflowDefinition> {
  const materializeNodes = async (
    sourceNodes: readonly WorkflowDefinition["graph"]["nodes"][number][],
    namespace: string
  ): Promise<WorkflowDefinition["graph"]["nodes"]> => await Promise.all(
    sourceNodes.map(async (node) => {
      if (node.type === "loop") {
        return {
          ...node,
          body: {
            nodes: await materializeNodes(
              node.body.nodes,
              `${namespace}.${node.id}`
            )
          }
        };
      }
      if (node.type !== "agent") {
        return node;
      }

      const agent = await loadAgentDefinition(agentsRoot, node.agent, {
        capabilityRegistry
      });
      const schemaId = `workflow-agent-schemas.${namespace}.${node.id}`;
      const outputSchema = node.output_schema.endsWith(".json")
        ? schemaId
        : node.output_schema;
      if (node.output_schema.endsWith(".json")) {
        schemaRegistrations[schemaId] = {
          id: schemaId,
          schema: agent.outputSchema as JsonSchemaLike
        };
      }

      return {
        ...node,
        output_schema: outputSchema,
        ...(workflow.execution.agent_sessions?.read_only === "shared" &&
        agent.mode === "read_only"
          ? { agent_session: { isolation: "shared" as const } }
          : {})
      };
    })
  );
  const nodes = await materializeNodes(workflow.graph.nodes, workflow.id);
  const compositions = await Promise.all(
    Object.entries(workflow.compositions ?? {}).map(async ([id, child]) => [
      id,
      await materializeNativeAgentSchemas(
        child,
        agentsRoot,
        capabilityRegistry,
        schemaRegistrations
      )
    ] as const)
  );
  return {
    ...workflow,
    graph: {
      ...workflow.graph,
      nodes
    },
    ...(compositions.length === 0
      ? {}
      : { compositions: Object.fromEntries(compositions) })
  };
}

function executableCompiledTree(
  compiled: CompiledWorkflow,
  includedRootIds?: ReadonlySet<string>
): CompiledWorkflow["nodes"] {
  return compiled.nodes
    .filter((node) => includedRootIds?.has(node.id) ?? true)
    .flatMap((node) => [
    node,
    ...(node.composition === undefined
      ? []
      : executableCompiledTree(node.composition.compiled))
    ]);
}

export async function loadWorkflowRuntimeConfig({
  workflow,
  configRoot
}: {
  readonly workflow: WorkflowDefinition;
  readonly configRoot: string;
}): Promise<JsonValue> {
  if (workflow.config === undefined) {
    return {};
  }

  const config = await loadYamlJsonSchemaFile(
    resolveWorkflowConfigPath(configRoot, workflow.config.file),
    workflow.config.schema_content
  );
  assertCheckpointJsonValue(config);

  return config;
}

function resolveWorkflowConfigPath(configRoot: string, relativePath: string): string {
  const root = path.resolve(configRoot);
  const resolved = path.resolve(root, relativePath);
  if (!isInsideRoot(root, resolved)) {
    throw runtimeError(
      "Workflow config file path escapes config directory",
      "runtime_state_invalid",
      { details: { config_root: root, path: relativePath } }
    );
  }

  return resolved;
}

export function runtimeCompositionConfig(
  app: AppConfig,
  projectRoot: string
): RuntimeCompositionConfig {
  const root = path.resolve(projectRoot, app.artifacts.root);

  return {
    mode: "production",
    backends: {
      artifacts: { id: "filesystem.artifacts", options: { root } },
      events: { id: "filesystem.events", options: { root } },
      interrupts: { id: "filesystem.interrupts", options: { root: path.join(root, "interrupts") } },
      checkpoints: {
        id: "sqlite.checkpoints",
        options: { filePath: path.join(root, "checkpoints.sqlite") }
      },
      runtime_logs: { id: "filesystem.runtime-log", options: { root } }
    },
    workflow_runtime: app.workflow_runtime ?? { id: "langgraph", options: {} },
    agent_runtime: app.agent_runtime ?? { id: "pi", options: {} },
    interrupt_authorization: { id: "allow_all", options: {} }
  };
}

export function workflowUsesAgents(workflow: WorkflowDefinition): boolean {
  const nodesUseAgents = (nodes: WorkflowDefinition["graph"]["nodes"]): boolean =>
    nodes.some((node) =>
      node.type === "agent" ||
      node.type === "pattern" ||
      (node.type === "loop" && nodesUseAgents(node.body.nodes))
    );
  return nodesUseAgents(workflow.graph.nodes) ||
    Object.values(workflow.compositions ?? {}).some(workflowUsesAgents);
}
