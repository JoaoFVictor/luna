import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadMcpConfig } from "../../src/core/config/mcp.js";

describe("MCP config", () => {
  it("loads configured MCP server ids", async () => {
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
        "      - read_only"
      ].join("\n"),
      "utf8"
    );

    await expect(loadMcpConfig(root)).resolves.toMatchObject({
      mcp_servers: [{ id: "github" }]
    });
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
        "      - trusted_local_write"
      ].join("\n"),
      "utf8"
    );

    await expect(loadMcpConfig(root)).rejects.toMatchObject({
      code: "mcp_config_duplicate_server"
    });
  });
});
