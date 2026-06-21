import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolDefinition } from "@flue/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../../src/core/agents/definition.js";
import { resolveFlueMcpTools } from "../../src/core/agent-runtime/flue/mcp-capabilities.js";
import { resolveFlueAgentCapabilities } from "../../src/core/agent-runtime/flue/capabilities.js";
import type { McpConfig } from "../../src/core/mcp-config.js";
import type { LunaObservability } from "../../src/core/observability/luna-observability.js";
import { createObservabilitySummary } from "../../src/core/observability/summary.js";

vi.mock("../../src/core/agent-runtime/flue/mcp-capabilities.js", () => ({
  resolveFlueMcpTools: vi.fn()
}));

function tool(name: string): ToolDefinition {
  return { name } as ToolDefinition;
}

function fakeObservability(): LunaObservability {
  return {
    eventContext: (severity) => ({
      severity,
      run: { id: "run-1", attempt: 1 },
      workflow: { id: "workflow-1" },
      timestamp: "2026-06-20T12:00:00.000Z"
    }),
    emit: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    isHardFailed: () => false,
    hardFailure: () => undefined
  };
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

async function writeImplementationReviewerFixture(
  root: string,
  modelProfile = "deep"
): Promise<void> {
  const reviewerDir = path.join(root, "agents", "change-reviewer");
  await mkdir(reviewerDir, { recursive: true });
  await writeFile(
    path.join(reviewerDir, "agent.yaml"),
    [
      "id: change-reviewer",
      "description: Reviews implementation diffs",
      `model_profile: ${modelProfile}`,
      "mode: read_only",
      "instructions_file: instructions.md",
      "output_schema: output.schema.json",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(path.join(reviewerDir, "instructions.md"), "Review the diff.\n");
  await writeFile(path.join(reviewerDir, "output.schema.json"), "{}\n");
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

  it("emits a resolved observability event for parent capabilities", async () => {
    const { root, agent } = await writeCodeImplementerFixture();
    const observability = fakeObservability();
    const summary = createObservabilitySummary({
      runId: "run-1",
      workflowId: "workflow-1"
    });

    try {
      await resolveFlueAgentCapabilities({
        agent,
        cwd: "/repo/worktree",
        observability,
        summary
      });

      expect(observability.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "luna.capabilities.resolved",
          severity: "info",
          outcome: { status: "succeeded" },
          data: expect.objectContaining({
            agent_id: "code-implementer",
            skills: 1,
            local_tools: 1,
            mcp_tools: 0,
            subagents: 0
          })
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves declared subagents into Flue agent profiles", async () => {
    const { root, agent } = await writeCodeImplementerFixture();

    try {
      await writeImplementationReviewerFixture(root);

      const capabilities = await resolveFlueAgentCapabilities({
        agent: { ...agent, subagents: [{ id: "change-reviewer" }] },
        cwd: "/repo/worktree",
        agentsRoot: path.join(root, "agents"),
        modelProfiles: {
          deep: { model: "test/deep", reasoning_effort: "high" }
        }
      });

      expect(capabilities.subagents).toHaveLength(1);
      expect(capabilities.subagents[0]).toMatchObject({
        name: "change-reviewer",
        description: "Reviews implementation diffs",
        model: "test/deep",
        thinkingLevel: "high"
      });
      expect(String(capabilities.subagents[0]?.instructions)).toContain(
        "Review the diff."
      );
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

  it("preserves known MCP resolver errors", async () => {
    const { root, agent } = await writeCodeImplementerFixture();
    const error = new Error("Missing environment variable LUNA_MCP_GITHUB_URL") as Error & {
      code: "mcp_env_missing";
    };
    error.code = "mcp_env_missing";

    vi.mocked(resolveFlueMcpTools).mockRejectedValueOnce(error);

    try {
      await expect(
        resolveFlueAgentCapabilities({
          agent: {
            ...agent,
            mcp_servers: ["github"]
          },
          cwd: "/repo/worktree"
        })
      ).rejects.toBe(error);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves subagent_context_missing when subagents are declared without context", async () => {
    const { root, agent } = await writeCodeImplementerFixture();

    try {
      await expect(
        resolveFlueAgentCapabilities({
          agent: { ...agent, subagents: [{ id: "change-reviewer" }] },
          cwd: "/repo/worktree"
        })
      ).rejects.toMatchObject({ code: "subagent_context_missing" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits a failed observability event when parent capability resolution fails", async () => {
    const { root, agent } = await writeCodeImplementerFixture();
    const observability = fakeObservability();

    try {
      await expect(
        resolveFlueAgentCapabilities({
          agent: { ...agent, subagents: [{ id: "change-reviewer" }] },
          cwd: "/repo/worktree",
          observability
        })
      ).rejects.toMatchObject({ code: "subagent_context_missing" });

      expect(observability.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "luna.capabilities.failed",
          severity: "error",
          outcome: { status: "failed" },
          data: expect.objectContaining({
            agent_id: "code-implementer",
            code: "subagent_context_missing"
          })
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves subagent_model_profile_missing through the combined resolver", async () => {
    const { root, agent } = await writeCodeImplementerFixture();

    try {
      await writeImplementationReviewerFixture(root, "missing");

      await expect(
        resolveFlueAgentCapabilities({
          agent: { ...agent, subagents: [{ id: "change-reviewer" }] },
          cwd: "/repo/worktree",
          agentsRoot: path.join(root, "agents"),
          modelProfiles: {}
        })
      ).rejects.toMatchObject({ code: "subagent_model_profile_missing" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves subagent_self_reference through the combined resolver", async () => {
    const { root, agent } = await writeCodeImplementerFixture();

    try {
      await expect(
        resolveFlueAgentCapabilities({
          agent: { ...agent, subagents: [{ id: agent.id }] },
          cwd: "/repo/worktree",
          agentsRoot: path.join(root, "agents"),
          modelProfiles: {
            deep: { model: "test/deep", reasoning_effort: "high" }
          }
        })
      ).rejects.toMatchObject({ code: "subagent_self_reference" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes cwd observability and summary into subagent capability resolution", async () => {
    const { root, agent } = await writeCodeImplementerFixture();
    const observability = fakeObservability();
    const summary = createObservabilitySummary({
      runId: "run-1",
      workflowId: "workflow-1"
    });
    const resolveFlueSubagentProfiles = vi.fn(async () => []);

    try {
      vi.resetModules();
      vi.doMock("../../src/core/agent-runtime/flue/mcp-capabilities.js", () => ({
        resolveFlueMcpTools: vi.fn(async () => ({
          tools: [],
          close: async () => {}
        }))
      }));
      vi.doMock("../../src/core/agent-runtime/flue/subagent-profiles.js", () => ({
        resolveFlueSubagentProfiles
      }));
      const { resolveFlueAgentCapabilities: resolveWithMockedSubagents } =
        await import("../../src/core/agent-runtime/flue/capabilities.js");

      await resolveWithMockedSubagents({
        agent: { ...agent, subagents: [{ id: "change-reviewer" }] },
        cwd: "/repo/worktree",
        agentsRoot: path.join(root, "agents"),
        modelProfiles: {
          deep: { model: "test/deep", reasoning_effort: "high" }
        },
        observability,
        summary,
        workflowSubagentPolicy: { allow_write: true }
      });

      expect(resolveFlueSubagentProfiles).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/repo/worktree",
          observability,
          summary,
          subagents: [{ id: "change-reviewer" }],
          workflowSubagentPolicy: { allow_write: true }
        })
      );
    } finally {
      vi.doUnmock("../../src/core/agent-runtime/flue/subagent-profiles.js");
      vi.doUnmock("../../src/core/agent-runtime/flue/mcp-capabilities.js");
      vi.resetModules();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves subagent_profile_capability_unsupported through the combined resolver", async () => {
    const { root, agent } = await writeCodeImplementerFixture();
    const subagentError = new Error("Unsupported Flue profile capability") as Error & {
      code: "subagent_profile_capability_unsupported";
    };
    subagentError.code = "subagent_profile_capability_unsupported";

    try {
      vi.resetModules();
      vi.doMock("../../src/core/agent-runtime/flue/mcp-capabilities.js", () => ({
        resolveFlueMcpTools: vi.fn(async () => ({
          tools: [],
          close: async () => {}
        }))
      }));
      vi.doMock("../../src/core/agent-runtime/flue/subagent-profiles.js", () => ({
        resolveFlueSubagentProfiles: vi.fn(async () => {
          throw subagentError;
        })
      }));
      const { resolveFlueAgentCapabilities: resolveWithMockedSubagents } =
        await import("../../src/core/agent-runtime/flue/capabilities.js");

      await expect(
        resolveWithMockedSubagents({
          agent: { ...agent, subagents: [{ id: "change-reviewer" }] },
          cwd: "/repo/worktree",
          agentsRoot: path.join(root, "agents"),
          modelProfiles: {
            deep: { model: "test/deep", reasoning_effort: "high" }
          }
        })
      ).rejects.toBe(subagentError);
    } finally {
      vi.doUnmock("../../src/core/agent-runtime/flue/subagent-profiles.js");
      vi.doUnmock("../../src/core/agent-runtime/flue/mcp-capabilities.js");
      vi.resetModules();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves unsupported subagent capability errors through the combined resolver", async () => {
    const { root, agent } = await writeCodeImplementerFixture();

    try {
      const reviewerDir = path.join(root, "agents", "change-reviewer");
      await mkdir(reviewerDir, { recursive: true });
      await writeFile(
        path.join(reviewerDir, "agent.yaml"),
        [
          "id: change-reviewer",
          "description: Reviews implementation diffs",
          "model_profile: deep",
          "mode: read_only",
          "instructions_file: instructions.md",
          "output_schema: output.schema.json",
          "mcp_servers:",
          "  - github",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        path.join(reviewerDir, "instructions.md"),
        "Review the diff.\n"
      );
      await writeFile(path.join(reviewerDir, "output.schema.json"), "{}\n");

      await expect(
        resolveFlueAgentCapabilities({
          agent: { ...agent, subagents: [{ id: "change-reviewer" }] },
          cwd: "/repo/worktree",
          agentsRoot: path.join(root, "agents"),
          modelProfiles: {
            deep: { model: "test/deep", reasoning_effort: "high" }
          }
        })
      ).rejects.toMatchObject({
        code: "subagent_mcp_not_allowed",
        message: expect.stringContaining("mcp_servers")
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not open MCP connections when subagent resolution fails", async () => {
    const { root, agent } = await writeCodeImplementerFixture();

    try {
      await writeImplementationReviewerFixture(root, "missing");
      const mcpConfig: McpConfig = {
        mcp_servers: [
          {
            id: "github",
            transport: "streamable-http",
            url_env: "LUNA_MCP_GITHUB_URL",
            headers: {},
            allowed_tools: ["get_pull_request"],
            allowed_agent_modes: ["read_only"],
            timeout_ms: 30000
          }
        ]
      };
      const env = { LUNA_MCP_GITHUB_URL: "https://mcp.example.test" };

      await expect(
        resolveFlueAgentCapabilities({
          agent: {
            ...agent,
            mode: "read_only",
            subagents: [{ id: "change-reviewer" }],
            mcp_servers: ["github"]
          },
          cwd: "/repo/worktree",
          agentsRoot: path.join(root, "agents"),
          modelProfiles: {},
          mcpConfig,
          env
        })
      ).rejects.toMatchObject({ code: "subagent_model_profile_missing" });

      expect(resolveFlueMcpTools).not.toHaveBeenCalled();
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
