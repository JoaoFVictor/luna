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
import {
  assertCheckpointJsonValue,
  type JsonValue
} from "../../core/runtime/json.js";
import { runtimeError } from "../../core/runtime/errors.js";
import { isInsideRoot } from "../../core/security/path.js";
import { compileWorkflow, type CompiledWorkflow } from "../../core/workflow/compiler.js";
import type { WorkflowDefinition } from "../../core/workflow/definition-types.js";
import { resolveRepository } from "../../core/workflow/workspace-resolver.js";
import type { RuntimeCompositionConfig } from "../../runtime/composition/app-config.js";
import type {
  NativeWorkflowRunInput
} from "../../runtime/composition/target-executor.js";
import {
  nativeLunaPlatformRegistrations,
  type NativeLunaPlatformRegistrations
} from "./native-platform-registrations.js";

export type NativeCompiledWorkflow = {
  readonly workflow: WorkflowDefinition;
  readonly compiled: CompiledWorkflow;
};

export type NativeRunContext = {
  readonly app: AppConfig;
  readonly agentsRoot: string;
  readonly workflow: WorkflowDefinition;
  readonly nativeWorkflow: NativeCompiledWorkflow;
  readonly repository?: RepositoryConfig;
  readonly run: ReturnType<typeof createRunIdentity>;
  readonly runtimeConfig: RuntimeCompositionConfig;
};

export type NativeRunContextDependencies = {
  readonly platform?: Pick<
    NativeLunaPlatformRegistrations,
    "capabilityRegistry" | "capabilityManifests"
  >;
};

export async function loadNativeRunContext(
  {
    invocation,
    target,
    projectRoot,
    configRoot
  }: NativeWorkflowRunInput,
  dependencies: NativeRunContextDependencies = {}
): Promise<NativeRunContext> {
  const platform = dependencies.platform ?? nativeLunaPlatformRegistrations;
  const app = await loadYamlFile(path.join(configRoot, "app.yaml"), AppConfigSchema);
  const repositories = await loadYamlFile(
    path.join(configRoot, "repositories.yaml"),
    RepositoriesConfigSchema
  );
  const agentsRoot = path.join(projectRoot, "agents");
  const workflow = await loadNativeWorkflowDefinition({
    projectRoot,
    workflowId: target.id,
    platform
  });
  const nativeWorkflow = await compileNativeWorkflow({
    workflow,
    agentsRoot,
    platform
  });
  const repository = workflow.requires.repository
    ? resolveRepository(invocation, repositories.repositories)
    : undefined;
  const run = createRunIdentity(
    { ...invocation, target },
    {
      attempt: 1,
      date: new Date(),
      workflowId: workflow.id,
      nonce: randomBytes(4).toString("hex")
    }
  );

  return {
    app,
    agentsRoot,
    workflow,
    nativeWorkflow,
    repository,
    run,
    runtimeConfig: runtimeCompositionConfig(app, projectRoot)
  };
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
  platform = nativeLunaPlatformRegistrations
}: {
  readonly workflow: WorkflowDefinition;
  readonly agentsRoot: string;
  readonly platform?: Pick<
    NativeLunaPlatformRegistrations,
    "capabilityRegistry" | "capabilityManifests"
  >;
}): Promise<NativeCompiledWorkflow> {
  const schemaRegistrations: Record<
    string,
    { readonly id: string; readonly schema: JsonSchemaLike }
  > = {};
  const nodes = await Promise.all(
    workflow.graph.nodes.map(async (node) => {
      if (node.type !== "agent") {
        return node;
      }

      const agent = await loadAgentDefinition(agentsRoot, node.agent, {
        capabilityRegistry: platform.capabilityRegistry
      });
      const schemaId = `workflow-agent-schemas.${workflow.id}.${node.id}`;
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
  const compiledWorkflow = {
    ...workflow,
    graph: {
      ...workflow.graph,
      nodes
    }
  };
  const registry =
    Object.keys(schemaRegistrations).length === 0
      ? platform.capabilityRegistry
      : createCapabilityRegistry([
          ...platform.capabilityManifests,
          capabilityManifest({
            id: "workflow-agent-schemas",
            kind: "execution",
            version: workflow.revision,
            schemas: schemaRegistrations
          })
        ]);

  return {
    workflow: compiledWorkflow,
    compiled: compileWorkflow({
      workflow: compiledWorkflow,
      registry,
      reducers: { steps: "object_merge" }
    })
  };
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
  return workflow.graph.nodes.some((node) =>
    node.type === "agent" || node.type === "pattern"
  );
}
