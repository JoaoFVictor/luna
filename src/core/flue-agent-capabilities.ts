import type { AgentProfile, Skill, ToolDefinition } from "@flue/runtime";
import type { AgentDefinition } from "./agent-definition.js";
import { resolveFlueMcpTools } from "./flue-mcp-capabilities.js";
import { loadFlueSkill } from "./flue-skill-loader.js";
import { resolveFlueSubagentProfiles } from "./flue-subagent-profiles.js";
import { resolveFlueTools } from "./flue-tool-registry.js";
import type { McpConfig } from "./mcp-config.js";
import type { ResolvedModelProfiles } from "./model-config.js";
import type { LunaObservability } from "./observability/luna-observability.js";
import type { ObservabilitySummary } from "./observability/summary.js";

export type ResolvedFlueAgentCapabilities = {
  skills: Skill[];
  tools: ToolDefinition[];
  subagents: AgentProfile[];
  close(): Promise<void>;
};

function capabilityError(
  message: string,
  cause: unknown
): Error & { code: "flue_capability_resolve_failed" } {
  const error = new Error(message, { cause }) as Error & {
    code: "flue_capability_resolve_failed";
  };
  error.code = "flue_capability_resolve_failed";

  return error;
}

function isUnknownToolError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "flue_tool_unknown" || code === "flue_tool_mode_not_allowed";
}

function isKnownMcpError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return (
    code === "mcp_server_unknown" ||
    code === "mcp_agent_mode_not_allowed" ||
    code === "mcp_env_missing" ||
    code === "mcp_server_connect_failed"
  );
}

function isKnownSubagentError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return (
    code === "subagent_self_reference" ||
    code === "subagent_model_profile_missing" ||
    code === "subagent_context_missing" ||
    code === "subagent_capabilities_unsupported" ||
    code === "subagent_profile_capability_unsupported"
  );
}

function subagentContextMissingError(
  agentId: string
): Error & { code: "subagent_context_missing" } {
  const error = new Error(
    `Agent ${agentId} declares subagents but agentsRoot and modelProfiles were not provided`
  ) as Error & { code: "subagent_context_missing" };
  error.code = "subagent_context_missing";

  return error;
}

async function emitCapabilityEvent(
  observability: LunaObservability | undefined,
  level: "info" | "error",
  event: string,
  attributes: Record<string, unknown>
): Promise<void> {
  await observability?.emit(level, event, attributes);
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;

  return typeof code === "string" ? code : undefined;
}

export async function resolveFlueAgentCapabilities({
  agent,
  cwd,
  agentsRoot,
  modelProfiles,
  mcpConfig,
  env,
  observability,
  summary,
  observabilitySummary
}: {
  agent: AgentDefinition;
  cwd: string;
  agentsRoot?: string;
  modelProfiles?: ResolvedModelProfiles;
  mcpConfig?: McpConfig;
  env?: Record<string, string | undefined>;
  observability?: LunaObservability;
  summary?: ObservabilitySummary;
  observabilitySummary?: ObservabilitySummary;
}): Promise<ResolvedFlueAgentCapabilities> {
  try {
    const skills = await Promise.all(
      (agent.skills ?? []).map((skillPath) =>
        loadFlueSkill(agent.directory, skillPath)
      )
    );
    const localTools = resolveFlueTools({
      ids: agent.tools ?? [],
      agentMode: agent.mode,
      cwd
    });
    const subagentIds = (agent.subagents ?? []).map((subagent) => subagent.id);
    const hasSubagents = subagentIds.length > 0;

    let subagents: AgentProfile[] = [];

    if (hasSubagents) {
      if (agentsRoot === undefined || modelProfiles === undefined) {
        throw subagentContextMissingError(agent.id);
      }

      subagents = await resolveFlueSubagentProfiles({
        agentsRoot,
        parentAgentId: agent.id,
        ids: subagentIds,
        modelProfiles,
        cwd,
        observability,
        summary,
        observabilitySummary
      });
    }
    const mcp = await resolveFlueMcpTools({
      ids: agent.mcp_servers ?? [],
      agentMode: agent.mode,
      config: mcpConfig ?? { mcp_servers: [] },
      env: env ?? process.env
    });

    await emitCapabilityEvent(
      observability,
      "info",
      "luna.capabilities.resolved",
      {
        agent_id: agent.id,
        status: "completed",
        skills: skills.length,
        local_tools: localTools.length,
        mcp_tools: mcp.tools.length,
        subagents: subagents.length
      }
    );

    return {
      skills,
      tools: [...localTools, ...mcp.tools],
      subagents,
      close: mcp.close
    };
  } catch (cause) {
    await emitCapabilityEvent(
      observability,
      "error",
      "luna.capabilities.failed",
      {
        agent_id: agent.id,
        status: "failed",
        ...(errorCode(cause) === undefined ? {} : { code: errorCode(cause) }),
        error: cause
      }
    );

    if (
      isUnknownToolError(cause) ||
      isKnownMcpError(cause) ||
      isKnownSubagentError(cause)
    ) {
      throw cause;
    }

    throw capabilityError(
      `Failed to resolve Flue capabilities for agent: ${agent.id}`,
      cause
    );
  }
}
