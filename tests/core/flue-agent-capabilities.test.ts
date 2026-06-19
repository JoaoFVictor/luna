import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolDefinition } from "@flue/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../../src/core/agent-definition.js";
import { resolveFlueMcpTools } from "../../src/core/flue-mcp-capabilities.js";
import { resolveFlueAgentCapabilities } from "../../src/core/flue-agent-capabilities.js";
import type { McpConfig } from "../../src/core/mcp-config.js";

vi.mock("../../src/core/flue-mcp-capabilities.js", () => ({
  resolveFlueMcpTools: vi.fn()
}));

function tool(name: string): ToolDefinition {
  return { name } as ToolDefinition;
}

async function writeCodeImplementerFixture(): Promise<{
  root: string;
  agent: AgentDefinition;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-flue-capabilities-"));
  const agentDir = path.join(root, "agents", "code-implementer");
  const skillDir = path.join(root, "skills", "implementation-safe-git");

  await mkdir(agentDir, { recursive: true });
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "instructions.md"),
    "Implement code safely.\n",
    "utf8"
  );
  await writeFile(
    path.join(agentDir, "output.schema.json"),
    JSON.stringify({ type: "object", additionalProperties: true }),
    "utf8"
  );
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: implementation-safe-git",
      "description: Safe git and file discipline for local implementation agents.",
      "---",
      "",
      "- Use repository evidence before changing files.",
      ""
    ].join("\n"),
    "utf8"
  );

  return {
    root,
    agent: {
      id: "code-implementer",
      description: "Implements code",
      model_profile: "deep",
      mode: "trusted_host_local_write",
      instructions_file: "instructions.md",
      output_schema: "output.schema.json",
      skills: ["../../skills/implementation-safe-git/SKILL.md"],
      tools: ["repository.status"],
      directory: agentDir,
      instructionsPath: path.join(agentDir, "instructions.md"),
      outputSchemaPath: path.join(agentDir, "output.schema.json")
    }
  };
}

describe("flue agent capabilities", () => {
  beforeEach(() => {
    vi.mocked(resolveFlueMcpTools).mockReset();
    vi.mocked(resolveFlueMcpTools).mockResolvedValue({
      tools: [],
      close: async () => {}
    });
  });

  it("loads local skill paths and resolves local tools", async () => {
    const { root, agent } = await writeCodeImplementerFixture();

    try {
      const capabilities = await resolveFlueAgentCapabilities({
        agent,
        cwd: "/repo/worktree"
      });

      expect(capabilities.skills).toHaveLength(1);
      expect(capabilities.skills[0]).toMatchObject({
        name: "implementation-safe-git",
        description: "Safe git and file discipline for local implementation agents."
      });
      expect(capabilities.tools).toHaveLength(1);
      expect(capabilities.tools[0]?.name).toBe("repository_status");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("combines local tools with allowed MCP tools and closes MCP capabilities", async () => {
    const { root, agent } = await writeCodeImplementerFixture();
    const close = vi.fn(async () => {});

    vi.mocked(resolveFlueMcpTools).mockResolvedValueOnce({
      tools: [tool("mcp__github__get_pull_request")],
      close
    });

    try {
      const mcpConfig: McpConfig = {
        mcp_servers: [
          {
            id: "github",
            transport: "streamable-http" as const,
            url_env: "LUNA_MCP_GITHUB_URL",
            headers: {},
            allowed_tools: ["get_pull_request"],
            allowed_agent_modes: ["read_only"],
            timeout_ms: 30000
          }
        ]
      };
      const env = {
        LUNA_MCP_GITHUB_URL: "https://mcp.example.test"
      };
      const capabilities = await resolveFlueAgentCapabilities({
        agent: {
          ...agent,
          mode: "read_only",
          mcp_servers: ["github"]
        },
        cwd: "/repo/worktree",
        mcpConfig,
        env
      });

      expect(capabilities.tools.map((resolvedTool) => resolvedTool.name)).toEqual([
        "repository_status",
        "mcp__github__get_pull_request"
      ]);
      expect(resolveFlueMcpTools).toHaveBeenCalledWith({
        ids: ["github"],
        agentMode: "read_only",
        config: mcpConfig,
        env
      });

      await capabilities.close();

      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a no-op close function for agents without MCP servers", async () => {
    const { root, agent } = await writeCodeImplementerFixture();

    try {
      const capabilities = await resolveFlueAgentCapabilities({
        agent: {
          ...agent,
          mcp_servers: undefined
        },
        cwd: "/repo/worktree"
      });

      await expect(capabilities.close()).resolves.toBeUndefined();
      expect(resolveFlueMcpTools).toHaveBeenCalledWith({
        ids: [],
        agentMode: agent.mode,
        config: { mcp_servers: [] },
        env: process.env
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves unknown local tool errors", async () => {
    const { root, agent } = await writeCodeImplementerFixture();

    try {
      await expect(
        resolveFlueAgentCapabilities({
          agent: {
            ...agent,
            tools: ["repository.missing"]
          },
          cwd: "/repo/worktree"
        })
      ).rejects.toMatchObject({
        code: "flue_tool_unknown",
        message: "Unknown Flue tool: repository.missing"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute skill paths", async () => {
    const { root, agent } = await writeCodeImplementerFixture();

    try {
      await expect(
        resolveFlueAgentCapabilities({
          agent: {
            ...agent,
            skills: [
              path.join(root, "skills", "implementation-safe-git", "SKILL.md")
            ]
          },
          cwd: "/repo/worktree"
        })
      ).rejects.toMatchObject({
        code: "flue_capability_resolve_failed"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects skill paths that escape the Luna capability root", async () => {
    const { root, agent } = await writeCodeImplementerFixture();
    const outsideRoot = await mkdtemp(
      path.join(tmpdir(), "luna-outside-skill-")
    );

    try {
      const outsideSkillDir = path.join(outsideRoot, "external-skill");
      await mkdir(outsideSkillDir, { recursive: true });
      await writeFile(
        path.join(outsideSkillDir, "SKILL.md"),
        [
          "---",
          "name: external-skill",
          "description: Should not be loadable from this agent.",
          "---",
          ""
        ].join("\n"),
        "utf8"
      );

      await expect(
        resolveFlueAgentCapabilities({
          agent: {
            ...agent,
            skills: [
              path.relative(
                agent.directory,
                path.join(outsideSkillDir, "SKILL.md")
              )
            ]
          },
          cwd: "/repo/worktree"
        })
      ).rejects.toMatchObject({
        code: "flue_capability_resolve_failed"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
