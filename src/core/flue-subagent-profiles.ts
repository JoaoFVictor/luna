import { readFile } from "node:fs/promises";
import {
  defineAgentProfile,
  type AgentProfile,
  type ToolDefinition
} from "@flue/runtime";
import { loadAgentDefinition } from "./agent-definition.js";
import { loadFlueSkill } from "./flue-skill-loader.js";
import { resolveFlueTools } from "./flue-tool-registry.js";
import {
  toFlueModelOptions,
  type ResolvedModelProfiles
} from "./model-config.js";
import type { LunaObservability } from "./observability/luna-observability.js";
import {
  recordRejectedCapability,
  type ObservabilitySummary
} from "./observability/summary.js";

function subagentError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;

  return error;
}

type RejectedSubagentCapability = {
  capability: string;
  id: string;
  reason: string;
};

function profileCapabilityError(
  agentId: string,
  cause: unknown
): Error & { code: "subagent_profile_capability_unsupported" } {
  const error = new Error(
    `Subagent ${agentId} uses capabilities unsupported by Flue AgentProfile`,
    { cause }
  ) as Error & { code: "subagent_profile_capability_unsupported" };
  error.code = "subagent_profile_capability_unsupported";

  return error;
}

async function emitRejectedCapability({
  observability,
  summary,
  agentId,
  rejection
}: {
  observability?: LunaObservability;
  summary?: ObservabilitySummary;
  agentId: string;
  rejection: RejectedSubagentCapability;
}): Promise<void> {
  recordRejectedCapability(summary, {
    agentId,
    capability: rejection.capability,
    id: rejection.id,
    reason: rejection.reason
  });

  await observability?.emit("warn", "luna.subagent.capability.rejected", {
    agent_id: agentId,
    status: "rejected",
    capability: rejection.capability,
    id: rejection.id,
    reason: rejection.reason
  });
}

async function rejectSubagentCapability({
  observability,
  summary,
  agentId,
  rejection
}: {
  observability?: LunaObservability;
  summary?: ObservabilitySummary;
  agentId: string;
  rejection: RejectedSubagentCapability;
}): Promise<never> {
  await emitRejectedCapability({
    observability,
    summary,
    agentId,
    rejection
  });

  throw subagentError(
    `Subagent ${agentId} declares unsupported capability for Flue profile mode: ${rejection.capability}:${rejection.id} (${rejection.reason})`,
    "subagent_capabilities_unsupported"
  );
}

function firstDeclaredCapability(
  capability: string,
  values: readonly string[] | undefined
): RejectedSubagentCapability | undefined {
  if (values === undefined || values.length === 0) {
    return undefined;
  }

  return {
    capability,
    id: values[0] ?? "unknown",
    reason: `${capability} are not supported for Flue subagents`
  };
}

function rejectedToolId(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) {
    return fallback;
  }

  const unknownMatch = /^Unknown Flue tool: (.+)$/.exec(cause.message);
  if (unknownMatch?.[1] !== undefined) {
    return unknownMatch[1];
  }

  const notAllowedMatch = /^Flue tool ([^\s]+) is not allowed/.exec(
    cause.message
  );
  if (notAllowedMatch?.[1] !== undefined) {
    return notAllowedMatch[1];
  }

  return fallback;
}

export async function resolveFlueSubagentProfiles({
  agentsRoot,
  parentAgentId,
  ids,
  modelProfiles,
  cwd,
  observability,
  summary,
  observabilitySummary
}: {
  agentsRoot: string;
  parentAgentId?: string;
  ids: readonly string[];
  modelProfiles: ResolvedModelProfiles;
  cwd?: string;
  observability?: LunaObservability;
  summary?: ObservabilitySummary;
  observabilitySummary?: ObservabilitySummary;
}): Promise<AgentProfile[]> {
  const profiles: AgentProfile[] = [];
  const resolvedSummary = summary ?? observabilitySummary;

  for (const id of ids) {
    if (id === parentAgentId) {
      throw subagentError(
        `Agent ${id} cannot reference itself as a subagent`,
        "subagent_self_reference"
      );
    }

    const agent = await loadAgentDefinition(agentsRoot, id);

    if (agent.mode !== "read_only") {
      await rejectSubagentCapability({
        observability,
        summary: resolvedSummary,
        agentId: id,
        rejection: {
          capability: "mode",
          id: agent.mode,
          reason: "Flue subagents must use read_only mode"
        }
      });
    }

    const unsupportedCapability =
      firstDeclaredCapability("mcp_servers", agent.mcp_servers) ??
      firstDeclaredCapability(
        "subagents",
        (agent.subagents ?? []).map((subagent) => subagent.id)
      );

    if (unsupportedCapability !== undefined) {
      await rejectSubagentCapability({
        observability,
        summary: resolvedSummary,
        agentId: id,
        rejection: unsupportedCapability
      });
    }

    const modelProfile = modelProfiles[agent.model_profile];

    if (modelProfile === undefined) {
      throw subagentError(
        `Model profile ${agent.model_profile} is not configured for subagent ${id}`,
        "subagent_model_profile_missing"
      );
    }

    const skills = await Promise.all(
      (agent.skills ?? []).map((skillPath) =>
        loadFlueSkill(agent.directory, skillPath)
      )
    );

    let tools: ToolDefinition[] = [];
    try {
      const toolIds = agent.tools ?? [];

      if (toolIds.length > 0 && cwd === undefined) {
        throw subagentError(
          `Subagent ${id} declares local tools but cwd was not provided`,
          "flue_tool_subagent_not_allowed"
        );
      }

      for (const toolId of toolIds) {
        tools.push(
          ...resolveFlueTools({
            ids: [toolId],
            agentMode: agent.mode,
            cwd: cwd ?? "",
            forSubagent: true
          })
        );
      }
    } catch (cause) {
      const toolId = rejectedToolId(cause, agent.tools?.[0] ?? "unknown");
      await rejectSubagentCapability({
        observability,
        summary: resolvedSummary,
        agentId: id,
        rejection: {
          capability: "tools",
          id: toolId,
          reason:
            cause instanceof Error ? cause.message : "Unsupported subagent tool"
        }
      });
    }

    try {
      profiles.push(
        defineAgentProfile({
          name: agent.id,
          description: agent.description,
          instructions: await readFile(agent.instructionsPath, "utf8"),
          skills,
          tools,
          ...toFlueModelOptions(modelProfile)
        })
      );
    } catch (cause) {
      throw profileCapabilityError(id, cause);
    }
  }

  return profiles;
}
