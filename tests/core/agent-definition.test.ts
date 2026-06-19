import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentDefinition } from "../../src/core/agent-definition.js";

async function tempAgentsRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "luna-agent-definition-"));
}

async function writeAgentYaml(
  agentDir: string,
  overrides: Partial<{
    id: string;
    description: string;
    model_profile: string;
    mode: string;
    instructions_file: string;
    output_schema: string;
  }> = {}
): Promise<void> {
  const metadata = {
    id: "review-planner",
    description: "Plans review work.",
    model_profile: "default",
    mode: "read_only",
    instructions_file: "instructions.md",
    output_schema: "output.schema.json",
    ...overrides
  };

  await writeFile(
    path.join(agentDir, "agent.yaml"),
    [
      `id: ${metadata.id}`,
      `description: ${metadata.description}`,
      `model_profile: ${metadata.model_profile}`,
      `mode: ${metadata.mode}`,
      `instructions_file: ${metadata.instructions_file}`,
      `output_schema: ${metadata.output_schema}`,
      ""
    ].join("\n"),
    "utf8"
  );
}

describe("agent definition loader", () => {
  it("loads agent.yaml and resolves instruction and schema paths", async () => {
    const root = await tempAgentsRoot();
    const agentDir = path.join(root, "review-planner");

    try {
      await mkdir(agentDir, { recursive: true });
      await writeAgentYaml(agentDir);
      await writeFile(path.join(agentDir, "instructions.md"), "# Planner\n", "utf8");
      await writeFile(path.join(agentDir, "output.schema.json"), "{}", "utf8");

      await expect(loadAgentDefinition(root, "review-planner")).resolves.toMatchObject({
        id: "review-planner",
        model_profile: "default",
        mode: "read_only",
        instructionsPath: path.join(agentDir, "instructions.md"),
        outputSchemaPath: path.join(agentDir, "output.schema.json")
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads trusted host local write agents", async () => {
    const root = await tempAgentsRoot();
    const agentDir = path.join(root, "code-implementer");

    try {
      await mkdir(agentDir, { recursive: true });
      await writeAgentYaml(agentDir, {
        id: "code-implementer",
        description: "Implements Jira tasks in a trusted local worktree.",
        model_profile: "deep",
        mode: "trusted_host_local_write"
      });
      await writeFile(path.join(agentDir, "instructions.md"), "# Implementer\n", "utf8");
      await writeFile(path.join(agentDir, "output.schema.json"), "{}", "utf8");

      await expect(loadAgentDefinition(root, "code-implementer")).resolves.toMatchObject({
        id: "code-implementer",
        mode: "trusted_host_local_write"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads optional skill paths and tool ids from agent.yaml", async () => {
    const root = await tempAgentsRoot();
    const agentDir = path.join(root, "code-implementer");

    try {
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        path.join(agentDir, "agent.yaml"),
        [
          "id: code-implementer",
          "description: Implements code",
          "model_profile: deep",
          "mode: trusted_host_local_write",
          "instructions_file: instructions.md",
          "output_schema: output.schema.json",
          "skills:",
          "  - ../../skills/implementation-safe-git/SKILL.md",
          "tools:",
          "  - repository.status",
          "  - repository.diff-summary",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(path.join(agentDir, "instructions.md"), "Implement.\n", "utf8");
      await writeFile(
        path.join(agentDir, "output.schema.json"),
        JSON.stringify({ type: "object", additionalProperties: true }),
        "utf8"
      );

      await expect(loadAgentDefinition(root, "code-implementer")).resolves.toMatchObject({
        skills: ["../../skills/implementation-safe-git/SKILL.md"],
        tools: ["repository.status", "repository.diff-summary"]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate tool ids in agent.yaml", async () => {
    const root = await tempAgentsRoot();
    const agentDir = path.join(root, "reviewer");

    try {
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        path.join(agentDir, "agent.yaml"),
        [
          "id: reviewer",
          "description: Reviews",
          "model_profile: default",
          "mode: read_only",
          "instructions_file: instructions.md",
          "output_schema: output.schema.json",
          "tools:",
          "  - repository.status",
          "  - repository.status",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(path.join(agentDir, "instructions.md"), "Review.\n", "utf8");
      await writeFile(
        path.join(agentDir, "output.schema.json"),
        JSON.stringify({ type: "object", additionalProperties: true }),
        "utf8"
      );

      await expect(loadAgentDefinition(root, "reviewer")).rejects.toMatchObject({
        code: "agent_capability_duplicate"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects agent ids that escape the agents root", async () => {
    await expect(loadAgentDefinition("agents", "../review-planner")).rejects.toMatchObject({
      code: "path_security_violation"
    });
  });

  it("rejects agent directory symlinks that resolve outside the agents root", async () => {
    const root = await tempAgentsRoot();
    const outsideRoot = await tempAgentsRoot();
    const outsideAgentDir = path.join(outsideRoot, "review-planner");

    try {
      await mkdir(outsideAgentDir, { recursive: true });
      await writeAgentYaml(outsideAgentDir);
      await writeFile(
        path.join(outsideAgentDir, "instructions.md"),
        "# Planner\n",
        "utf8"
      );
      await writeFile(path.join(outsideAgentDir, "output.schema.json"), "{}", "utf8");
      await symlink(outsideAgentDir, path.join(root, "review-planner"), "dir");

      await expect(loadAgentDefinition(root, "review-planner")).rejects.toMatchObject({
        code: "agent_path_escape"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it.each([
    "instructions_file",
    "output_schema"
  ] as const)("rejects %s paths that escape the agent directory", async (field) => {
    const root = await tempAgentsRoot();
    const agentDir = path.join(root, "review-planner");

    try {
      await mkdir(agentDir, { recursive: true });
      await writeAgentYaml(agentDir, { [field]: "../outside.md" });
      if (field === "output_schema") {
        await writeFile(path.join(agentDir, "instructions.md"), "# Planner\n", "utf8");
      }

      await expect(loadAgentDefinition(root, "review-planner")).rejects.toMatchObject({
        code: "agent_path_escape"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["instructions_file", "instructions.md"],
    ["output_schema", "output.schema.json"]
  ] as const)(
    "rejects %s symlinks that resolve outside the agent directory",
    async (field, fileName) => {
      const root = await tempAgentsRoot();
      const agentDir = path.join(root, "review-planner");
      const outsideFile = path.join(root, `outside-${fileName}`);

      try {
        await mkdir(agentDir, { recursive: true });
        await writeAgentYaml(agentDir, { [field]: fileName });
        await writeFile(outsideFile, "external\n", "utf8");
        if (field === "output_schema") {
          await writeFile(path.join(agentDir, "instructions.md"), "# Planner\n", "utf8");
        }
        await symlink(outsideFile, path.join(agentDir, fileName));

        await expect(loadAgentDefinition(root, "review-planner")).rejects.toMatchObject({
          code: "agent_path_escape"
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("throws agent_path_missing when a referenced agent file does not exist", async () => {
    const root = await tempAgentsRoot();
    const agentDir = path.join(root, "review-planner");

    try {
      await mkdir(agentDir, { recursive: true });
      await writeAgentYaml(agentDir);

      await expect(loadAgentDefinition(root, "review-planner")).rejects.toMatchObject({
        code: "agent_path_missing"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["review-planner", "code-reviewer", "acceptance-reviewer"])(
    "loads the committed %s agent definition",
    async (agentId) => {
      await expect(loadAgentDefinition("agents", agentId)).resolves.toMatchObject({
        id: agentId,
        mode: "read_only",
        instructionsPath: path.resolve("agents", agentId, "instructions.md"),
        outputSchemaPath: path.resolve("agents", agentId, "output.schema.json")
      });
    }
  );
});
