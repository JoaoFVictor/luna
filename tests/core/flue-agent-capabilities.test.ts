import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/core/agent-definition.js";
import { resolveFlueAgentCapabilities } from "../../src/core/flue-agent-capabilities.js";

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
});
