import { readFile } from "node:fs/promises";
import { defineAgentProfile, type AgentProfile } from "@flue/runtime";
import { loadAgentDefinition } from "./agent-definition.js";
import {
  toFlueModelOptions,
  type ResolvedModelProfiles
} from "./model-config.js";

function subagentError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;

  return error;
}

function declaredCapabilities(agent: {
  skills?: readonly string[];
  tools?: readonly string[];
  mcp_servers?: readonly string[];
  subagents?: readonly string[];
}): string[] {
  return [
    ["skills", agent.skills],
    ["tools", agent.tools],
    ["mcp_servers", agent.mcp_servers],
    ["subagents", agent.subagents]
  ].flatMap(([kind, values]) =>
    Array.isArray(values) && values.length > 0 ? [kind as string] : []
  );
}

export async function resolveFlueSubagentProfiles({
  agentsRoot,
  parentAgentId,
  ids,
  modelProfiles
}: {
  agentsRoot: string;
  parentAgentId?: string;
  ids: readonly string[];
  modelProfiles: ResolvedModelProfiles;
}): Promise<AgentProfile[]> {
  const profiles: AgentProfile[] = [];

  for (const id of ids) {
    if (id === parentAgentId) {
      throw subagentError(
        `Agent ${id} cannot reference itself as a subagent`,
        "subagent_self_reference"
      );
    }

    const agent = await loadAgentDefinition(agentsRoot, id);
    const unsupportedCapabilities = declaredCapabilities(agent);

    if (unsupportedCapabilities.length > 0) {
      throw subagentError(
        `Subagent ${id} declares unsupported capabilities for Flue profile mode: ${unsupportedCapabilities.join(
          ", "
        )}`,
        "subagent_capabilities_unsupported"
      );
    }

    const modelProfile = modelProfiles[agent.model_profile];

    if (modelProfile === undefined) {
      throw subagentError(
        `Model profile ${agent.model_profile} is not configured for subagent ${id}`,
        "subagent_model_profile_missing"
      );
    }

    profiles.push(
      defineAgentProfile({
        name: agent.id,
        description: agent.description,
        instructions: await readFile(agent.instructionsPath, "utf8"),
        ...toFlueModelOptions(modelProfile)
      })
    );
  }

  return profiles;
}
