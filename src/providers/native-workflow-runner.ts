import { randomBytes } from "node:crypto";
import path from "node:path";
import { loadAgentDefinition } from "../capabilities/agents/agent-loader.js";
import { officialCapabilityRegistry } from "../capabilities/registry.js";
import { builtInStepNameForWorkflowCapability } from "../core/built-ins/workflow-aliases.js";
import { loadYamlFile } from "../core/config/loader.js";
import { loadMcpConfig } from "../core/config/mcp.js";
import { resolveModelProfiles } from "../core/config/models.js";
import {
  AppConfigSchema,
  ModelsConfigSchema,
  RepositoriesConfigSchema,
  type AppConfig,
  type RepositoryConfig
} from "../core/config/schemas.js";
import { createRunIdentity } from "../core/invocation/run-identity.js";
import type { JsonValue } from "../core/runtime/json.js";
import {
  defaultProviderBuiltInStepRegistry,
  defaultProviderWorkflowBuiltIns
} from "./built-ins.js";
import { lunaToolCatalog } from "../core/tools/catalog.js";
import { resolveToolCatalog } from "../core/tools/resolved-catalog.js";
import { compileWorkflow } from "../core/workflow/compiler.js";
import { loadWorkflowDefinition } from "../core/workflow/definition.js";
import { RunLockManager } from "../core/workflow/lock-manager.js";
import {
  runCompiledWorkflow,
  type WorkflowAgentInputMap
} from "../runtime/langgraph/workflow-runner.js";
import {
  gatedAgentGateKey,
  gatedAgentWorkerKey
} from "../runtime/langgraph/gated-agent-loop-keys.js";
import { resolveRepository } from "../core/workflow/workspace-resolver.js";
import { registerConfiguredPiOAuthProviders } from "../agent-runtimes/pi/auth.js";
import {
  createRuntimeCompositionForWorkflow
} from "../runtime/composition/runtime-composition.js";
import type { RuntimeCompositionConfig } from "../runtime/composition/app-config.js";
import type {
  NativeWorkflowRunInput
} from "../runtime/composition/target-executor.js";

export async function runNativeWorkflowTarget({
  invocation,
  target,
  projectRoot,
  configRoot
}: NativeWorkflowRunInput): Promise<void> {
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
  const runtimeConfig = runtimeCompositionConfig(app, projectRoot);
  if (runtimeConfig.agent_runtime.id === "pi" && workflowUsesAgents(workflow)) {
    await registerConfiguredPiOAuthProviders({ configRoot });
  }
  const composition = createRuntimeCompositionForWorkflow(
    runtimeConfig,
    workflow,
    { capabilityRegistry: officialCapabilityRegistry }
  );

  await runCompiledWorkflow({
    compiled: compileWorkflow({ workflow, registry: officialCapabilityRegistry }),
    workflow,
    invocation: invocation as unknown as JsonValue,
    config: {},
    run,
    runtimeContext: {
      repository,
      workspaceRoot: path.resolve(projectRoot, app.workspace.root),
      agentsRoot
    },
    backends: composition.backends,
    builtIns: defaultProviderWorkflowBuiltIns(),
    builtInMetadata: (node) => {
      const name = builtInStepNameForWorkflowCapability(node.capability_id);
      return defaultProviderBuiltInStepRegistry.has(name)
        ? defaultProviderBuiltInStepRegistry.require(name).metadata ?? {}
        : {};
    },
    lockManager: new RunLockManager({
      root: lockRoot(app, projectRoot),
      runId: run.run_id,
      timeoutMs: app.locks?.timeout_ms ?? 300_000,
      staleAfterMs: app.locks?.stale_after_ms ?? 900_000
    }),
    agentRuntime: composition.agentRuntime,
    langGraphCheckpointer: composition.langGraphCheckpointer,
    agentInputs: await workflowAgentInputs({
      workflow,
      agentsRoot,
      repository,
      configRoot
    })
  });
}

function workflowUsesAgents(workflow: Awaited<ReturnType<typeof loadWorkflowDefinition>>): boolean {
  return workflow.graph.nodes.some((node) =>
    node.type === "agent" || node.type === "pattern"
  );
}

function runtimeCompositionConfig(
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

function lockRoot(app: AppConfig, projectRoot: string): string {
  return path.resolve(
    projectRoot,
    app.locks?.root ?? path.join(app.artifacts.root, "locks")
  );
}

async function workflowAgentInputs({
  workflow,
  agentsRoot,
  repository,
  configRoot
}: {
  readonly workflow: Awaited<ReturnType<typeof loadWorkflowDefinition>>;
  readonly agentsRoot: string;
  readonly repository?: RepositoryConfig;
  readonly configRoot: string;
}): Promise<WorkflowAgentInputMap> {
  const models = resolveModelProfiles(
    await loadYamlFile(path.join(configRoot, "models.yaml"), ModelsConfigSchema)
  );
  const mcpConfig = await loadMcpConfig(configRoot);
  const entries = await Promise.all(
    workflowAgentSpecs(workflow).map(async ({ key, agentId }) => {
      const agent = await loadAgentDefinition(agentsRoot, agentId);
      const modelProfile = models[agent.model_profile];
      if (modelProfile === undefined) {
        throw new Error(
          `Agent ${agent.id} references unknown model profile ${agent.model_profile}`
        );
      }

      return [
        key,
        {
          instructions: agent.instructions,
          model_profile: modelProfile,
          tools: resolveToolCatalog({
            registry: officialCapabilityRegistry,
            local_tools: lunaToolCatalog,
            requested_local_tool_ids: agent.tools ?? [],
            requested_mcp_server_ids: agent.mcp_servers ?? [],
            agent_mode: agent.mode,
            mcp_config: mcpConfig
          }),
          runtime_requirements: agent.runtime_requirements ?? [],
          context: {},
          output_schema: agent.outputSchema,
          cwd: repository?.path
        }
      ] as const;
    })
  );

  return Object.fromEntries(entries);
}

function workflowAgentSpecs(
  workflow: Awaited<ReturnType<typeof loadWorkflowDefinition>>
): { readonly key: string; readonly agentId: string }[] {
  const specs: { readonly key: string; readonly agentId: string }[] = [];

  for (const node of workflow.graph.nodes) {
    if (node.type === "agent") {
      specs.push({ key: node.id, agentId: node.agent });
      continue;
    }

    if (node.type !== "pattern") {
      continue;
    }

    if (node.worker !== undefined) {
      specs.push({ key: gatedAgentWorkerKey(node.id), agentId: node.worker });
    }

    for (const gate of node.gates ?? []) {
      const reviewAgent = gate.input?.review_agent;
      if (gate.type === "quality-gates.agent_review" && typeof reviewAgent === "string") {
        specs.push({
          key: gatedAgentGateKey(node.id, gate.id),
          agentId: reviewAgent
        });
      }
    }
  }

  return specs;
}
