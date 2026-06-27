import type {
  ResolveEffectiveSkillReferencesOptions,
  ResolvedSkillReference
} from "../../core/skills/definition.js";
import { resolveEffectiveSkillReferences } from "../../core/skills/definition.js";
import type { AgentDefinitionProjection } from "./agent-definition.js";

export type AgentSkillSources = ResolveEffectiveSkillReferencesOptions;

export type AgentProjectionDefaults = {
  readonly agent: AgentDefinitionProjection;
};

export function requireAgentProjection({
  defaults,
  agentId
}: {
  readonly defaults: AgentProjectionDefaults;
  readonly agentId: string;
}): AgentDefinitionProjection {
  if (defaults.agent.id !== agentId) {
    const error = new Error(
      `Agent defaults for ${agentId} do not match the compiled workflow node`
    ) as Error & { code: string; details: Record<string, unknown> };
    error.code = "runtime_state_invalid";
    error.details = {
      expected_agent_id: agentId,
      actual_agent_id: defaults.agent.id,
      agent_mode: defaults.agent.mode
    };
    throw error;
  }

  return defaults.agent;
}

export async function resolveAgentSkills({
  skillSources,
  workspace
}: {
  readonly skillSources?: AgentSkillSources;
  readonly workspace?: unknown;
}): Promise<readonly ResolvedSkillReference[] | undefined> {
  if (skillSources === undefined) {
    return undefined;
  }

  return await resolveEffectiveSkillReferences({
    ...skillSources,
    repository: skillSources.repository === undefined
      ? undefined
      : {
          ...skillSources.repository,
          root: workspacePath(workspace) ?? skillSources.repository.root
        }
  });
}

export function workspacePath(workspace: unknown): string | undefined {
  if (
    typeof workspace === "object" &&
    workspace !== null &&
    !Array.isArray(workspace) &&
    typeof (workspace as { path?: unknown }).path === "string"
  ) {
    return (workspace as { path: string }).path;
  }

  return undefined;
}
