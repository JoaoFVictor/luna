import { readFile } from "node:fs/promises";
import {
  defineAgentProfile,
  type AgentProfile,
  type ToolDefinition
} from "@flue/runtime";
import { loadAgentDefinition } from "./agent-definition.js";
import { loadFlueSkill } from "./flue-skill-loader.js";
import { resolveFlueTools } from "./agent-runtime/flue/tool-registry.js";
import {
  toFlueModelOptions,
  type ResolvedModelProfiles
} from "./model-config.js";
import {
  customEvent,
  type LunaObservability
} from "./observability/luna-observability.js";
import { sanitizeJsonObject } from "./observability/sanitize.js";
import {
  recordRejectedCapability,
  type ObservabilitySummary
} from "./observability/summary.js";
import {
  type AgentSubagentReference,
  resolveSubagentPolicy,
  type ResolvedSubagentPolicy,
  type WorkflowSubagentPolicy
} from "./subagent-policy.js";

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

  if (observability !== undefined) {
    await observability.emit(
      customEvent({
        ...observability.eventContext("warn"),
        type: "luna.subagent.capability.rejected",
        outcome: { status: "failed" },
        data: sanitizeJsonObject({
          agent_id: agentId,
          capability: rejection.capability,
          id: rejection.id,
          reason: rejection.reason
        })
      })
    );
  }
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

async function rejectSubagentWithNamedError({
  observability,
  summary,
  agentId,
  rejection,
  message,
  code
}: {
  observability?: LunaObservability;
  summary?: ObservabilitySummary;
  agentId: string;
  rejection: RejectedSubagentCapability;
  message: string;
  code: string;
}): Promise<never> {
  await emitRejectedCapability({
    observability,
    summary,
    agentId,
    rejection
  });

  throw subagentError(message, code);
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

function subagentErrorCode(cause: unknown): string | undefined {
  const code = (cause as { code?: unknown } | undefined)?.code;

  return typeof code === "string" ? code : undefined;
}

export async function resolveFlueSubagentProfiles({
  agentsRoot,
  parentAgentId,
  subagents,
  modelProfiles,
  workflowSubagentPolicy,
  cwd,
  observability,
  summary,
  observabilitySummary
}: {
  agentsRoot: string;
  parentAgentId?: string;
  subagents: readonly AgentSubagentReference[];
  modelProfiles: ResolvedModelProfiles;
  workflowSubagentPolicy?: WorkflowSubagentPolicy;
  cwd?: string;
  observability?: LunaObservability;
  summary?: ObservabilitySummary;
  observabilitySummary?: ObservabilitySummary;
}): Promise<AgentProfile[]> {
  const profiles: AgentProfile[] = [];
  const resolvedSummary = summary ?? observabilitySummary;

  for (const reference of subagents) {
    const id = reference.id;
    if (id === parentAgentId) {
      throw subagentError(
        `Agent ${id} cannot reference itself as a subagent`,
        "subagent_self_reference"
      );
    }

    const agent = await loadAgentDefinition(agentsRoot, id);
    let resolvedPolicy: ResolvedSubagentPolicy;
    try {
      resolvedPolicy = resolveSubagentPolicy(
        workflowSubagentPolicy,
        reference.policy
      );
    } catch (cause) {
      await emitRejectedCapability({
        observability,
        summary: resolvedSummary,
        agentId: id,
        rejection: {
          capability: "mode",
          id: reference.policy?.mode ?? "read_only",
          reason:
            cause instanceof Error
              ? cause.message
              : "Subagent policy could not be resolved"
        }
      });

      if (cause instanceof Error) {
        throw cause;
      }

      throw subagentError(
        "Subagent policy could not be resolved",
        "subagent_capabilities_unsupported"
      );
    }

    if (agent.mode !== resolvedPolicy.mode) {
      await rejectSubagentCapability({
        observability,
        summary: resolvedSummary,
        agentId: id,
        rejection: {
          capability: "mode",
          id: agent.mode,
          reason: `Flue subagent must use policy mode ${resolvedPolicy.mode}`
        }
      });
    }

    const unsupportedMcp = firstDeclaredCapability(
      "mcp_servers",
      agent.mcp_servers
    );

    if (unsupportedMcp !== undefined) {
      await rejectSubagentWithNamedError({
        observability,
        summary: resolvedSummary,
        agentId: id,
        rejection: unsupportedMcp,
        message: `Subagent ${id} declares MCP capability that is not allowed: ${unsupportedMcp.capability}:${unsupportedMcp.id}`,
        code: "subagent_mcp_not_allowed"
      });
    }

    const unsupportedNestedSubagent = firstDeclaredCapability(
      "subagents",
      (agent.subagents ?? []).map((subagent) => subagent.id)
    );

    if (unsupportedNestedSubagent !== undefined) {
      await rejectSubagentWithNamedError({
        observability,
        summary: resolvedSummary,
        agentId: id,
        rejection: unsupportedNestedSubagent,
        message: `Subagent ${id} declares nested subagent capability that is not allowed: ${unsupportedNestedSubagent.capability}:${unsupportedNestedSubagent.id}`,
        code: "subagent_nested_not_allowed"
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
      const allowedTools = new Set(resolvedPolicy.allow_tools);

      if (resolvedPolicy.mode === "read_only" && toolIds.length > 0) {
        await rejectSubagentWithNamedError({
          observability,
          summary: resolvedSummary,
          agentId: id,
          rejection: {
            capability: "tools",
            id: toolIds[0] ?? "unknown",
            reason: "Read-only subagents cannot receive local tools"
          },
          message: `Subagent ${id} declares read-only local tool capability that is not allowed: tools:${toolIds[0] ?? "unknown"}`,
          code: "subagent_read_only_allow_tools_invalid"
        });
      }

      if (toolIds.length > 0 && cwd === undefined) {
        throw subagentError(
          `Subagent ${id} declares local tools but cwd was not provided`,
          "flue_tool_subagent_not_allowed"
        );
      }

      for (const toolId of toolIds) {
        if (
          resolvedPolicy.mode === "trusted_host_local_write" &&
          !allowedTools.has(toolId)
        ) {
          await rejectSubagentCapability({
            observability,
            summary: resolvedSummary,
            agentId: id,
            rejection: {
              capability: "tools",
              id: toolId,
              reason: "Tool is not allowed by subagent policy"
            }
          });
        }

        tools.push(
          ...resolveFlueTools({
            ids: [toolId],
            agentMode: agent.mode,
            cwd: cwd ?? ""
          })
        );
      }
    } catch (cause) {
      if (subagentErrorCode(cause)?.startsWith("subagent_") === true) {
        throw cause;
      }

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
