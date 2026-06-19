import {
  connectMcpServer as defaultConnectMcpServer,
  type ToolDefinition
} from "@flue/runtime";
import type { AgentDefinition } from "./agent-definition.js";
import type { McpConfig, McpServerConfig } from "./mcp-config.js";

type McpCapabilityErrorCode =
  | "mcp_agent_mode_not_allowed"
  | "mcp_env_missing"
  | "mcp_server_unknown";

type ConnectMcpServer = typeof defaultConnectMcpServer;
type McpConnection = Awaited<ReturnType<ConnectMcpServer>>;

export type ResolvedFlueMcpTools = {
  tools: ToolDefinition[];
  close(): Promise<void>;
};

function mcpCapabilityError(
  message: string,
  code: McpCapabilityErrorCode
): Error & { code: McpCapabilityErrorCode } {
  const error = new Error(message) as Error & { code: McpCapabilityErrorCode };
  error.code = code;

  return error;
}

function adaptedMcpToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function requireEnv(
  env: Record<string, string | undefined>,
  name: string,
  serverId: string
): string {
  const value = env[name];

  if (value === undefined || value === "") {
    throw mcpCapabilityError(
      `Missing environment variable ${name} for MCP server ${serverId}`,
      "mcp_env_missing"
    );
  }

  return value;
}

function findServer(config: McpConfig, id: string): McpServerConfig {
  const server = config.mcp_servers.find(
    (configuredServer) => configuredServer.id === id
  );

  if (server === undefined) {
    throw mcpCapabilityError(`Unknown MCP server: ${id}`, "mcp_server_unknown");
  }

  return server;
}

function assertAgentModeAllowed(
  server: McpServerConfig,
  agentMode: AgentDefinition["mode"]
): void {
  if (!server.allowed_agent_modes.includes(agentMode)) {
    throw mcpCapabilityError(
      `MCP server ${server.id} is not allowed for agent mode ${agentMode}`,
      "mcp_agent_mode_not_allowed"
    );
  }
}

function resolveHeaders(
  server: McpServerConfig,
  env: Record<string, string | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(server.headers).map(([name, header]) => [
      name,
      `${header.prefix ?? ""}${requireEnv(env, header.env, server.id)}`
    ])
  );
}

async function closeConnections(connections: McpConnection[]): Promise<void> {
  await Promise.all(connections.map((connection) => connection.close()));
}

export async function resolveFlueMcpTools({
  ids,
  agentMode,
  config,
  env,
  connectMcpServer = defaultConnectMcpServer
}: {
  ids: string[];
  agentMode: AgentDefinition["mode"];
  config: McpConfig;
  env: Record<string, string | undefined>;
  connectMcpServer?: ConnectMcpServer;
}): Promise<ResolvedFlueMcpTools> {
  const connections: McpConnection[] = [];
  const tools: ToolDefinition[] = [];

  try {
    for (const id of ids) {
      const server = findServer(config, id);
      assertAgentModeAllowed(server, agentMode);

      const url = requireEnv(env, server.url_env, server.id);
      const headers = resolveHeaders(server, env);
      const connection = await connectMcpServer(server.id, {
        url,
        transport: server.transport,
        headers,
        timeoutMs: server.timeout_ms
      });
      connections.push(connection);

      const allowedToolNames = new Set(
        server.allowed_tools.map((toolName) =>
          adaptedMcpToolName(server.id, toolName)
        )
      );
      tools.push(
        ...connection.tools.filter((toolDefinition) =>
          allowedToolNames.has(toolDefinition.name)
        )
      );
    }
  } catch (cause) {
    await Promise.allSettled(
      connections.map((connection) => connection.close())
    );
    throw cause;
  }

  return {
    tools,
    close: () => closeConnections(connections)
  };
}
