import { randomBytes } from "node:crypto";
import path from "node:path";
import { loadAgentDefinition } from "../capabilities/agents/agent-loader.js";
import {
  officialCapabilityManifests,
  officialCapabilityRegistry
} from "../capabilities/registry.js";
import { capabilityManifest } from "../core/capabilities/manifest.js";
import type { JsonSchemaLike } from "../core/capabilities/pattern-registration.js";
import { createCapabilityRegistry } from "../core/capabilities/registry.js";
import { loadYamlFile } from "../core/config/loader.js";
import {
  AppConfigSchema,
  RepositoriesConfigSchema,
  type AppConfig,
  type RepositoryConfig
} from "../core/config/schemas.js";
import { ImplementationConfigSchema } from "../core/write-mode/types.js";
import { createRunIdentity } from "../core/invocation/run-identity.js";
import type { JsonValue } from "../core/runtime/json.js";
import { compileWorkflow, type CompiledWorkflow } from "../core/workflow/compiler.js";
import { loadWorkflowDefinition } from "../core/workflow/definition.js";
import type { WorkflowDefinition } from "../core/workflow/definition-types.js";
import { resolveRepository } from "../core/workflow/workspace-resolver.js";
import type { RuntimeCompositionConfig } from "../runtime/composition/app-config.js";
import type {
  NativeWorkflowRunInput
} from "../runtime/composition/target-executor.js";

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

export async function loadNativeRunContext({
  invocation,
  target,
  projectRoot,
  configRoot
}: NativeWorkflowRunInput): Promise<NativeRunContext> {
  const app = await loadYamlFile(path.join(configRoot, "app.yaml"), AppConfigSchema);
  const repositories = await loadYamlFile(
    path.join(configRoot, "repositories.yaml"),
    RepositoriesConfigSchema
  );
  const agentsRoot = path.join(projectRoot, "agents");
  const workflow = await loadWorkflowDefinition(
    path.join(projectRoot, "workflows"),
    target.id,
    { agentsRoot, capabilityRegistry: officialCapabilityRegistry }
  );
  const nativeWorkflow = await compileNativeWorkflow({ workflow, agentsRoot });
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

export async function compileNativeWorkflow({
  workflow,
  agentsRoot
}: {
  readonly workflow: WorkflowDefinition;
  readonly agentsRoot: string;
}): Promise<NativeCompiledWorkflow> {
  const schemaRegistrations: Record<
    string,
    { readonly id: string; readonly schema: JsonSchemaLike }
  > = {};
  const nodes = await Promise.all(
    workflow.graph.nodes.map(async (node) => {
      if (
        node.type !== "agent" ||
        !node.output_schema.endsWith(".json")
      ) {
        return node;
      }

      const schemaId = `workflow-agent-schemas.${workflow.id}.${node.id}`;
      const agent = await loadAgentDefinition(agentsRoot, node.agent);
      schemaRegistrations[schemaId] = {
        id: schemaId,
        schema: agent.outputSchema as JsonSchemaLike
      };

      return { ...node, output_schema: schemaId };
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
      ? officialCapabilityRegistry
      : createCapabilityRegistry([
          ...officialCapabilityManifests,
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
  if (workflow.mode !== "trusted_local_write") {
    return {};
  }

  return (await loadYamlFile(
    path.join(configRoot, "implementation.yaml"),
    ImplementationConfigSchema
  )) as unknown as JsonValue;
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
      interrupts: { id: "memory.interrupts", options: {} },
      checkpoints: {
        id: "sqlite.checkpoints",
        options: { filePath: path.join(root, "checkpoints.sqlite") }
      },
      runtime_logs: { id: "filesystem.runtime-log", options: { root } }
    },
    agent_runtime: app.agent_runtime ?? { id: "pi", options: {} },
    interrupt_authorization: { id: "allow_all", options: {} }
  };
}

export function workflowUsesAgents(workflow: WorkflowDefinition): boolean {
  return workflow.graph.nodes.some((node) =>
    node.type === "agent" || node.type === "pattern"
  );
}
