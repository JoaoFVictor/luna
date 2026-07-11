import path from "node:path";
import {
  loadAgentDefinition
} from "../../capabilities/agents/agent-loader.js";
import type {
  AgentMetadata
} from "../../capabilities/agents/agent-definition.js";
import type { CapabilityRegistry } from "../../core/capabilities/registry.js";
import { loadYamlFile } from "../../core/config/loader.js";
import {
  resolveModelProfiles,
  type ResolvedModelProfiles
} from "../../core/config/models.js";
import {
  ModelsConfigSchema,
  type ModelProfile
} from "../../core/config/schemas.js";
import { collectWorkflowAgentReferences } from "../../core/workflow/definition-references.js";
import type { WorkflowDefinition } from "../../core/workflow/definition-types.js";

function unknownModelProfile(agent: Pick<AgentMetadata, "id" | "model_profile">) {
  const error = new Error(
    `Agent ${agent.id} references unknown model profile ${agent.model_profile}`
  ) as Error & { readonly code: string };
  Object.defineProperty(error, "code", {
    value: "agent_model_profile_unknown",
    enumerable: true
  });
  return error;
}

export async function loadNativeModelProfiles(
  configRoot: string
): Promise<ResolvedModelProfiles> {
  return resolveModelProfiles(
    await loadYamlFile(path.join(configRoot, "models.yaml"), ModelsConfigSchema)
  );
}

export function requireNativeAgentModelProfile(
  agent: Pick<AgentMetadata, "id" | "model_profile">,
  profiles: ResolvedModelProfiles
): ModelProfile {
  const profile = profiles[agent.model_profile];
  if (profile === undefined) {
    throw unknownModelProfile(agent);
  }
  return profile;
}

export async function assertNativeWorkflowAgentModelProfiles(options: {
  readonly workflow: WorkflowDefinition;
  readonly agentsRoot: string;
  readonly configRoot: string;
  readonly capabilityRegistry: CapabilityRegistry;
}): Promise<void> {
  const agentIds = [...new Set(
    collectWorkflowAgentReferences(options.workflow.graph.nodes)
      .map(({ agentId }) => agentId)
  )];
  if (agentIds.length === 0) {
    return;
  }
  const profiles = await loadNativeModelProfiles(options.configRoot);
  await Promise.all(agentIds.map(async (agentId) => {
    const agent = await loadAgentDefinition(options.agentsRoot, agentId, {
      capabilityRegistry: options.capabilityRegistry
    });
    requireNativeAgentModelProfile(agent, profiles);
  }));
}
