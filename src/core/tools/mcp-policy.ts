import type { McpConfig, McpServerConfig } from "../config/mcp.js";
import type { LunaToolMode } from "./contracts.js";
import type { AgentRuntimeRequirement } from "../agent-runtime/contracts.js";

export type ResolvedMcpPolicyTool = {
  readonly id: string;
  readonly protocol: "mcp";
  readonly server_id: string;
  readonly tool_name: string;
};

export type ResolvedMcpPolicyServer = {
  readonly id: string;
  readonly transport: McpServerConfig["transport"];
  readonly allowed_tools: readonly string[];
  readonly timeout_ms: number;
};

export type ResolvedMcpPolicy = {
  readonly servers: readonly ResolvedMcpPolicyServer[];
  readonly tools: readonly ResolvedMcpPolicyTool[];
  readonly runtime_requirements: readonly AgentRuntimeRequirement[];
};

type McpPolicyErrorCode =
  | "mcp_policy_server_unknown"
  | "mcp_policy_agent_mode_not_allowed";

class McpPolicyError extends Error {
  readonly code: McpPolicyErrorCode;

  constructor(code: McpPolicyErrorCode, message: string) {
    super(message);
    this.name = "McpPolicyError";
    this.code = code;
  }
}

function findServer(config: McpConfig, id: string): McpServerConfig {
  const server = config.mcp_servers.find((candidate) => candidate.id === id);

  if (server === undefined) {
    throw new McpPolicyError(
      "mcp_policy_server_unknown",
      `Unknown MCP server: ${id}`
    );
  }

  return server;
}

function assertAgentModeAllowed(server: McpServerConfig, agentMode: LunaToolMode): void {
  if (server.allowed_agent_modes.includes(agentMode)) {
    return;
  }

  throw new McpPolicyError(
    "mcp_policy_agent_mode_not_allowed",
    `MCP server ${server.id} is not allowed for agent mode ${agentMode}`
  );
}

function runtimeRequirements(tools: readonly ResolvedMcpPolicyTool[]): AgentRuntimeRequirement[] {
  return tools.length === 0 ? [] : ["tool_calling", "mcp_tools"];
}

export function resolveMcpPolicy({
  requested_server_ids,
  agent_mode,
  config
}: {
  readonly requested_server_ids: readonly string[];
  readonly agent_mode: LunaToolMode;
  readonly config: McpConfig;
}): ResolvedMcpPolicy {
  const servers: ResolvedMcpPolicyServer[] = [];
  const tools: ResolvedMcpPolicyTool[] = [];

  for (const serverId of requested_server_ids) {
    const server = findServer(config, serverId);
    assertAgentModeAllowed(server, agent_mode);

    servers.push({
      id: server.id,
      transport: server.transport,
      allowed_tools: server.allowed_tools,
      timeout_ms: server.timeout_ms
    });

    for (const toolName of server.allowed_tools) {
      tools.push({
        id: `${server.id}.${toolName}`,
        protocol: "mcp",
        server_id: server.id,
        tool_name: toolName
      });
    }
  }

  return {
    servers,
    tools,
    runtime_requirements: runtimeRequirements(tools)
  };
}
