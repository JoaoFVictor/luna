import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentDefinition } from "../../../src/capabilities/agents/agent-loader.js";

async function tempAgentsRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "luna-cap-agent-loader-"));
}

async function writeAgent(agentDir: string): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "agent.yaml"),
    [
      "id: implementer",
      "description: Implements tasks",
      "model_profile: deep",
      "mode: trusted_local_write",
      "instructions_file: instructions.md",
      "output_schema: output.schema.json",
      "runtime_requirements:",
      "  - tool_calling",
      "runtime_preferences:",
      "  preferred_runtime: flue",
      "metadata:",
      "  owner: workflow-platform",
      "skills:",
      "  - ../../skills/implementation-safe-git/SKILL.md",
      "tools:",
      "  - repository.status",
      "context:",
      "  files:",
      "    - guidance.md",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(path.join(agentDir, "instructions.md"), "Implement.\n", "utf8");
  await writeFile(
    path.join(agentDir, "output.schema.json"),
    JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { status: { enum: ["done"] } }
    }),
    "utf8"
  );
}

describe("agents capability loader", () => {
  it("loads provider-neutral agent.yaml metadata, instructions, and output schema", async () => {
    const root = await tempAgentsRoot();

    try {
      await writeAgent(path.join(root, "implementer"));

      await expect(loadAgentDefinition(root, "implementer")).resolves.toMatchObject({
        id: "implementer",
        description: "Implements tasks",
        model_profile: "deep",
        mode: "trusted_local_write",
        instructions: "Implement.\n",
        outputSchema: {
          type: "object",
          required: ["status"],
          properties: { status: { enum: ["done"] } }
        },
        runtime_requirements: ["tool_calling"],
        runtime_preferences: { preferred_runtime: "flue" },
        metadata: { owner: "workflow-platform" },
        skills: ["../../skills/implementation-safe-git/SKILL.md"],
        tools: ["repository.status"],
        context: { files: ["guidance.md"] }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects output schemas that escape the agent directory", async () => {
    const root = await tempAgentsRoot();

    try {
      const agentDir = path.join(root, "implementer");
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        path.join(agentDir, "agent.yaml"),
        [
          "id: implementer",
          "description: Implements tasks",
          "model_profile: deep",
          "mode: read_only",
          "instructions_file: instructions.md",
          "output_schema: ../output.schema.json",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(path.join(agentDir, "instructions.md"), "Implement.\n", "utf8");
      await writeFile(path.join(root, "output.schema.json"), "{}\n", "utf8");

      await expect(loadAgentDefinition(root, "implementer")).rejects.toMatchObject({
        code: "agent_path_escape"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
