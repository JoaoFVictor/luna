import { loadAgentDefinition } from "../../capabilities/agents/agent-loader.js";
import {
  gatedAgentGateKey
} from "../../capabilities/quality-gates/gated-agent-loop-keys.js";
import { patternWorkerKey } from "../../capabilities/agents/pattern-agent-runner.js";
import { loadMcpConfig } from "../../core/config/mcp.js";
import type { CapabilityRegistry } from "../../core/capabilities/registry.js";
import type { RepositoryConfig } from "../../core/config/schemas.js";
import { lunaToolCatalog } from "../../capabilities/repository/tool-catalog.js";
import { resolveToolCatalog } from "../../core/tools/resolved-catalog.js";
import type { WorkflowDefinition } from "../../core/workflow/definition-types.js";
import type { ParsedWorkflowNode } from "../../core/workflow/definition-types.js";
import { workflowLoopBodyNodeKey } from "../../core/workflow/loop-identity.js";
import type { WorkflowAgentInputMap } from "../../core/workflow/execution-contracts.js";
import { nativeLunaPlatformRegistrations } from "./native-platform-registrations.js";
import {
  loadNativeModelProfiles,
  requireNativeAgentModelProfile
} from "./native-agent-model-profiles.js";

export async function buildNativeWorkflowAgentInputs({
  workflow,
  agentsRoot,
  repository,
  configRoot,
  signal,
  capabilityRegistry = nativeLunaPlatformRegistrations.capabilityRegistry
}: {
  readonly workflow: WorkflowDefinition;
  readonly agentsRoot: string;
  readonly repository?: RepositoryConfig;
  readonly configRoot: string;
  readonly signal?: AbortSignal;
  readonly capabilityRegistry?: CapabilityRegistry;
}): Promise<WorkflowAgentInputMap> {
  const specs = workflowAgentSpecs(workflow);
  if (specs.length === 0) {
    return {};
  }

  const models = await loadNativeModelProfiles(configRoot);
  const mcpConfig = await loadMcpConfig(configRoot);
  const entries = await Promise.all(
    specs.map(async ({ key, agentId }) => {
      const agent = await loadAgentDefinition(agentsRoot, agentId, {
        capabilityRegistry
      });
      const modelProfile = requireNativeAgentModelProfile(agent, models);

      return [
        key,
        {
          agent: {
            id: agent.id,
            mode: agent.mode,
            instructions: agent.instructions,
            tools: agent.tools,
            mcp_servers: agent.mcp_servers,
            skills: agent.skills,
            runtime_requirements: agent.runtime_requirements
          },
          model_profile: modelProfile,
          tools: resolveToolCatalog({
            registry: capabilityRegistry,
            local_tools: lunaToolCatalog,
            requested_local_tool_ids: agent.tools ?? [],
            requested_mcp_server_ids: agent.mcp_servers ?? [],
            agent_mode: agent.mode,
            mcp_config: mcpConfig
          }),
          skill_sources: {
            repository: repository === undefined
              ? undefined
              : {
                  root: repository.path,
                  skills: repository.skills
                },
            agentDirectory: agent.directory,
            agentSkills: agent.skills
          },
          runtime_requirements: agent.runtime_requirements ?? [],
          output_schema: agent.outputSchema,
          cwd: repository?.path,
          ...(signal === undefined ? {} : { signal })
        }
      ] as const;
    })
  );

  return Object.fromEntries(entries);
}

function workflowAgentSpecs(
  workflow: WorkflowDefinition
): { readonly key: string; readonly agentId: string }[] {
  return workflowNodeAgentSpecs(workflow.graph.nodes);
}

function workflowNodeAgentSpecs(
  nodes: readonly ParsedWorkflowNode[],
  loopNodeId?: string
): { readonly key: string; readonly agentId: string }[] {
  const specs: { readonly key: string; readonly agentId: string }[] = [];

  for (const node of nodes) {
    if (node.type === "loop") {
      specs.push(...workflowNodeAgentSpecs(node.body.nodes, node.id));
      continue;
    }
    if (node.type === "agent") {
      specs.push({
        key: loopNodeId === undefined
          ? node.id
          : workflowLoopBodyNodeKey(loopNodeId, node.id),
        agentId: node.agent
      });
      continue;
    }

    if (node.type !== "pattern") {
      continue;
    }

    if (node.worker !== undefined) {
      specs.push({ key: patternWorkerKey(node.id), agentId: node.worker });
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
