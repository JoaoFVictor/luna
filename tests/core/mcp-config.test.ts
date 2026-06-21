import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadMcpConfig } from "../../src/core/config/mcp.js";

describe("MCP config", () => {
  it("loads configured MCP servers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-mcp-config-"));
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "mcp.yaml"),
      [
        "mcp_servers:",
        "  - id: github",
        "    transport: streamable-http",
        "    url_env: GITHUB_MCP_URL",
        "    headers:",
        "      Authorization:",
        "        env: GITHUB_MCP_TOKEN",
        "        prefix: Bearer",
        "    allowed_tools:",
        "      - issues.list",
        "    allowed_agent_modes:",
        "      - read_only",
        "      - trusted_host_local_write",
        "    timeout_ms: 15000"
      ].join("\n"),
      "utf8"
    );

    await expect(loadMcpConfig(root)).resolves.toEqual({
      mcp_servers: [
        {
          id: "github",
          transport: "streamable-http",
          url_env: "GITHUB_MCP_URL",
          headers: {
            Authorization: {
              env: "GITHUB_MCP_TOKEN",
              prefix: "Bearer"
            }
          },
          allowed_tools: ["issues.list"],
          allowed_agent_modes: ["read_only", "trusted_host_local_write"],
          timeout_ms: 15000
        }
      ]
    });
  });

  it("returns an empty MCP server list when mcp.yaml is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-mcp-config-"));

    await expect(loadMcpConfig(root)).resolves.toEqual({ mcp_servers: [] });
  });

  it("rejects duplicate MCP server ids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-mcp-config-"));
    await writeFile(
      path.join(root, "mcp.yaml"),
      [
        "mcp_servers:",
        "  - id: github",
        "    transport: streamable-http",
        "    url_env: GITHUB_MCP_URL",
        "    allowed_tools:",
        "      - issues.list",
        "    allowed_agent_modes:",
        "      - read_only",
        "  - id: github",
        "    transport: sse",
        "    url_env: GITHUB_MCP_SSE_URL",
        "    allowed_tools:",
        "      - issues.get",
        "    allowed_agent_modes:",
        "      - trusted_host_local_write"
      ].join("\n"),
      "utf8"
    );

    await expect(loadMcpConfig(root)).rejects.toMatchObject({
      code: "mcp_config_duplicate_server"
    });
  });
});
