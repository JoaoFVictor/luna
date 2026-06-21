import type { ToolDefinition } from "@flue/runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveFlueMcpTools } from "../../src/core/agent-runtime/flue/mcp-capabilities.js";
import type { McpConfig } from "../../src/core/mcp-config.js";

function tool(name: string): ToolDefinition {
  return { name } as ToolDefinition;
}

const config: McpConfig = {
  mcp_servers: [
    {
      id: "github",
      transport: "streamable-http",
      url_env: "LUNA_MCP_GITHUB_URL",
      headers: {
        Authorization: { env: "LUNA_MCP_GITHUB_TOKEN", prefix: "Bearer " }
      },
      allowed_tools: ["get_pull_request"],
      allowed_agent_modes: ["read_only"],
      timeout_ms: 30000
    }
  ]
};

describe("flue mcp capabilities", () => {
  it("connects configured MCP servers and filters tools by allowlist", async () => {
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const connectMcpServer = vi.fn().mockResolvedValue({
      name: "github",
      tools: [
        tool("mcp__github__get_pull_request"),
        tool("mcp__github__delete_repo")
      ],
      close
    });

    const result = await resolveFlueMcpTools({
      ids: ["github"],
      agentMode: "read_only",
      config,
      env: {
        LUNA_MCP_GITHUB_URL: "https://mcp.example.test",
        LUNA_MCP_GITHUB_TOKEN: "token"
      },
      connectMcpServer
    });

    expect(result.tools.map((resolvedTool) => resolvedTool.name)).toEqual([
      "mcp__github__get_pull_request"
    ]);
    expect(connectMcpServer).toHaveBeenCalledWith("github", {
      url: "https://mcp.example.test",
      transport: "streamable-http",
      headers: { Authorization: "Bearer token" },
      timeoutMs: 30000
    });

    await result.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("matches runtime MCP adapted names for sanitized server and tool parts", async () => {
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const connectMcpServer = vi.fn().mockResolvedValue({
      name: "github.enterprise",
      tools: [
        tool("mcp__github_enterprise__get_pull-request"),
        tool("mcp__github_enterprise__unnamed"),
        tool("mcp__github_enterprise__ignored")
      ],
      close
    });

    const result = await resolveFlueMcpTools({
      ids: ["github.enterprise"],
      agentMode: "read_only",
      config: {
        mcp_servers: [
          {
            id: "github.enterprise",
            transport: "streamable-http",
            url_env: "LUNA_MCP_GITHUB_ENTERPRISE_URL",
            headers: {},
            allowed_tools: ["get.pull-request", "..."],
            allowed_agent_modes: ["read_only"],
            timeout_ms: 30000
          }
        ]
      },
      env: {
        LUNA_MCP_GITHUB_ENTERPRISE_URL: "https://mcp.example.test"
      },
      connectMcpServer
    });

    expect(result.tools.map((resolvedTool) => resolvedTool.name)).toEqual([
      "mcp__github_enterprise__get_pull-request",
      "mcp__github_enterprise__unnamed"
    ]);
  });

  it("rejects MCP servers not allowed for agent mode", async () => {
    await expect(
      resolveFlueMcpTools({
        ids: ["github"],
        agentMode: "trusted_host_local_write",
        config,
        env: {
          LUNA_MCP_GITHUB_URL: "https://mcp.example.test",
          LUNA_MCP_GITHUB_TOKEN: "token"
        },
        connectMcpServer: vi.fn()
      })
    ).rejects.toMatchObject({
      code: "mcp_agent_mode_not_allowed"
    });
  });

  it("rejects missing URL or header env", async () => {
    await expect(
      resolveFlueMcpTools({
        ids: ["github"],
        agentMode: "read_only",
        config,
        env: {
          LUNA_MCP_GITHUB_TOKEN: "token"
        },
        connectMcpServer: vi.fn()
      })
    ).rejects.toMatchObject({
      code: "mcp_env_missing"
    });

    await expect(
      resolveFlueMcpTools({
        ids: ["github"],
        agentMode: "read_only",
        config,
        env: {
          LUNA_MCP_GITHUB_URL: "https://mcp.example.test"
        },
        connectMcpServer: vi.fn()
      })
    ).rejects.toMatchObject({
      code: "mcp_env_missing"
    });
  });

  it("wraps connect failures and closes already opened connections", async () => {
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const connectFailure = new Error("connection failed");
    const connectMcpServer = vi
      .fn()
      .mockResolvedValueOnce({
        name: "github",
        tools: [tool("mcp__github__get_pull_request")],
        close
      })
      .mockRejectedValueOnce(connectFailure);

    await expect(
      resolveFlueMcpTools({
        ids: ["github", "linear"],
        agentMode: "read_only",
        config: {
          mcp_servers: [
            ...config.mcp_servers,
            {
              id: "linear",
              transport: "sse",
              url_env: "LUNA_MCP_LINEAR_URL",
              headers: {},
              allowed_tools: ["get_issue"],
              allowed_agent_modes: ["read_only"],
              timeout_ms: 15000
            }
          ]
        },
        env: {
          LUNA_MCP_GITHUB_URL: "https://github-mcp.example.test",
          LUNA_MCP_GITHUB_TOKEN: "token",
          LUNA_MCP_LINEAR_URL: "https://linear-mcp.example.test"
        },
        connectMcpServer
      })
    ).rejects.toMatchObject({
      code: "mcp_server_connect_failed",
      message: expect.stringContaining("linear"),
      cause: connectFailure
    });

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("wraps local tool filtering failures and closes the opened connection", async () => {
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const filterFailure = new Error("tool name unavailable");
    const throwingTool = Object.defineProperty({}, "name", {
      get() {
        throw filterFailure;
      }
    }) as ToolDefinition;
    const connectMcpServer = vi.fn().mockResolvedValue({
      name: "github",
      tools: [throwingTool],
      close
    });

    await expect(
      resolveFlueMcpTools({
        ids: ["github"],
        agentMode: "read_only",
        config,
        env: {
          LUNA_MCP_GITHUB_URL: "https://mcp.example.test",
          LUNA_MCP_GITHUB_TOKEN: "token"
        },
        connectMcpServer
      })
    ).rejects.toMatchObject({
      code: "mcp_server_connect_failed",
      message: expect.stringContaining("github"),
      cause: filterFailure
    });

    expect(close).toHaveBeenCalledTimes(1);
  });
});
