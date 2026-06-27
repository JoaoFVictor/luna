import { describe, expect, it } from "vitest";
import {
  resolveMcpPolicy
} from "../../../src/core/tools/mcp-policy.js";
import type { McpConfig } from "../../../src/core/config/mcp.js";

const config: McpConfig = {
  mcp_servers: [
    {
      id: "github",
      transport: "streamable-http",
      url_env: "LUNA_MCP_GITHUB_URL",
      headers: {},
      allowed_tools: ["get_pull_request"],
      allowed_agent_modes: ["read_only"],
      timeout_ms: 30_000
    },
    {
      id: "playwright",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      env_vars: [],
      allowed_tools: ["browser_navigate"],
      allowed_agent_modes: ["read_only"],
      timeout_ms: 60_000
    }
  ]
};

describe("MCP policy", () => {
  it("resolves only explicitly requested MCP servers and their allowlisted tools", () => {
    const policy = resolveMcpPolicy({
      requested_server_ids: ["github"],
      agent_mode: "read_only",
      config
    });

    expect(policy.servers).toEqual([
      {
        id: "github",
        transport: "streamable-http",
        allowed_tools: ["get_pull_request"],
        timeout_ms: 30_000
      }
    ]);
    expect(policy.tools).toEqual([
      {
        id: "github.get_pull_request",
        protocol: "mcp",
        server_id: "github",
        tool_name: "get_pull_request"
      }
    ]);
    expect(policy.runtime_requirements).toEqual(["tool_calling", "mcp_tools"]);
  });

  it("does not materialize MCP tools implicitly from agent text", () => {
    const policy = resolveMcpPolicy({
      requested_server_ids: [],
      agent_mode: "read_only",
      config
    });

    expect(policy.tools).toEqual([]);
    expect(policy.runtime_requirements).toEqual([]);
  });

  it("keeps MCP server policy free of stdio materialization details", () => {
    const policy = resolveMcpPolicy({
      requested_server_ids: ["playwright"],
      agent_mode: "read_only",
      config
    });

    expect(policy.servers).toEqual([
      {
        id: "playwright",
        transport: "stdio",
        allowed_tools: ["browser_navigate"],
        timeout_ms: 60_000
      }
    ]);
    expect(policy.servers[0]).not.toHaveProperty("command");
    expect(policy.servers[0]).not.toHaveProperty("args");
    expect(policy.servers[0]).not.toHaveProperty("env_vars");
    expect(policy.tools).toEqual([
      {
        id: "playwright.browser_navigate",
        protocol: "mcp",
        server_id: "playwright",
        tool_name: "browser_navigate"
      }
    ]);
  });

  it("rejects unknown servers and disallowed agent modes", () => {
    expect(() =>
      resolveMcpPolicy({
        requested_server_ids: ["linear"],
        agent_mode: "read_only",
        config
      })
    ).toThrow(expect.objectContaining({ code: "mcp_policy_server_unknown" }));

    expect(() =>
      resolveMcpPolicy({
        requested_server_ids: ["github"],
        agent_mode: "trusted_local_write",
        config
      })
    ).toThrow(expect.objectContaining({ code: "mcp_policy_agent_mode_not_allowed" }));
  });
});
