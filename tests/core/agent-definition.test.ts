import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { officialCapabilityRegistry } from "../../src/capabilities/registry.js";
import { loadAgentDefinition } from "../../src/capabilities/agents/agent-loader.js";

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
    context_files: readonly string[];
    runtime_requirements: readonly string[];
    runtime_preferences: readonly string[];
    metadata: readonly string[];
    skills: readonly string[];
    tools: readonly string[];
  }> = {}
): Promise<void> {
  const metadata = {
    id: "review-planner",
    description: "Plans review work.",
    model_profile: "default",
    mode: "read_only",
    instructions_file: "instructions.md",
    output_schema: "output.schema.json",
    context_files: [],
    runtime_requirements: [],
    runtime_preferences: [],
    metadata: [],
    skills: [],
    tools: [],
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
      ...(metadata.runtime_requirements.length > 0
        ? ["runtime_requirements:", ...metadata.runtime_requirements.map((item) => `  - ${item}`)]
        : []),
      ...(metadata.runtime_preferences.length > 0
        ? ["runtime_preferences:", ...metadata.runtime_preferences.map((item) => `  ${item}`)]
        : []),
      ...(metadata.metadata.length > 0
        ? ["metadata:", ...metadata.metadata.map((item) => `  ${item}`)]
        : []),
      ...(metadata.skills.length > 0
        ? ["skills:", ...metadata.skills.map((item) => `  - ${item}`)]
        : []),
      ...(metadata.tools.length > 0
        ? ["tools:", ...metadata.tools.map((item) => `  - ${item}`)]
        : []),
      ...(metadata.context_files.length > 0
        ? ["context:", "  files:", ...metadata.context_files.map((file) => `    - ${file}`)]
        : []),
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
      await writeAgentYaml(agentDir, {
        runtime_requirements: ["tool_calling"],
        skills: ["../../skills/implementation-safe-git/SKILL.md"]
      });
      await writeFile(path.join(agentDir, "instructions.md"), "# Planner\n", "utf8");
      await writeFile(path.join(agentDir, "output.schema.json"), "{}", "utf8");

      await expect(loadAgentDefinition(root, "review-planner")).resolves.toMatchObject({
        instructionsPath: path.join(agentDir, "instructions.md"),
        outputSchemaPath: path.join(agentDir, "output.schema.json"),
        instructions: "# Planner\n",
        outputSchema: {},
        runtime_requirements: ["tool_calling"],
        skills: ["../../skills/implementation-safe-git/SKILL.md"]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads capability-registered output schemas", async () => {
    const root = await tempAgentsRoot();
    const agentDir = path.join(root, "change-reviewer");

    try {
      await mkdir(agentDir, { recursive: true });
      await writeAgentYaml(agentDir, {
        id: "change-reviewer",
        output_schema: "findings.review_output"
      });
      await writeFile(path.join(agentDir, "instructions.md"), "# Review\n", "utf8");

      await expect(
        loadAgentDefinition(root, "change-reviewer", {
          capabilityRegistry: officialCapabilityRegistry
        })
      ).resolves.toMatchObject({
        outputSchemaPath: "findings.review_output",
        outputSchema: officialCapabilityRegistry
          .registrations()
          .schemas.get("findings.review_output")?.schema
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown capability-registered output schemas", async () => {
    const root = await tempAgentsRoot();
    const agentDir = path.join(root, "change-reviewer");

    try {
      await mkdir(agentDir, { recursive: true });
      await writeAgentYaml(agentDir, {
        id: "change-reviewer",
        output_schema: "findings.unknown"
      });
      await writeFile(path.join(agentDir, "instructions.md"), "# Review\n", "utf8");

      await expect(
        loadAgentDefinition(root, "change-reviewer", {
          capabilityRegistry: officialCapabilityRegistry
        })
      ).rejects.toMatchObject({
        code: "agent_output_schema_unknown"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads object subagents with write policy overrides", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-agent-definition-"));
    const agentDir = path.join(root, "code-implementer");

    try {
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        path.join(agentDir, "agent.yaml"),
        [
          "id: code-implementer",
          "description: Implements code",
          "model_profile: deep",
          "mode: trusted_local_write",
          "instructions_file: instructions.md",
          "output_schema: output.schema.json",
          "subagents:",
          "  - id: implementer-helper",
          "    policy:",
          "      mode: trusted_local_write",
          "      allow_tools:",
          "        - repository.status",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(path.join(agentDir, "instructions.md"), "Implement.\n", "utf8");
      await writeFile(path.join(agentDir, "output.schema.json"), "{}\n", "utf8");

      await expect(loadAgentDefinition(root, "code-implementer")).resolves.toMatchObject({
        subagents: [
          {
            id: "implementer-helper",
            policy: {
              mode: "trusted_local_write",
              allow_tools: ["repository.status"]
            }
          }
        ]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate object-form subagent ids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-agent-definition-"));
    const agentDir = path.join(root, "code-implementer");

    try {
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        path.join(agentDir, "agent.yaml"),
        [
          "id: code-implementer",
          "description: Implements code",
          "model_profile: deep",
          "mode: trusted_local_write",
          "instructions_file: instructions.md",
          "output_schema: output.schema.json",
          "subagents:",
          "  - change-reviewer",
          "  - id: change-reviewer",
          "    policy:",
          "      mode: read_only",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(path.join(agentDir, "instructions.md"), "Implement.\n", "utf8");
      await writeFile(path.join(agentDir, "output.schema.json"), "{}\n", "utf8");

      await expect(loadAgentDefinition(root, "code-implementer")).rejects.toMatchObject({
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

  it("rejects configured file paths that escape the agent directory", async () => {
    const root = await tempAgentsRoot();
    const agentDir = path.join(root, "review-planner");

    try {
      await mkdir(agentDir, { recursive: true });
      await writeAgentYaml(agentDir, { instructions_file: "../outside.md" });

      await expect(loadAgentDefinition(root, "review-planner")).rejects.toMatchObject({
        code: "agent_path_escape"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects configured file symlinks that resolve outside the agent directory", async () => {
    const root = await tempAgentsRoot();
    const agentDir = path.join(root, "review-planner");
    const outsideFile = path.join(root, "outside-instructions.md");

    try {
      await mkdir(agentDir, { recursive: true });
      await writeAgentYaml(agentDir);
      await writeFile(outsideFile, "external\n", "utf8");
      await symlink(outsideFile, path.join(agentDir, "instructions.md"));

      await expect(loadAgentDefinition(root, "review-planner")).rejects.toMatchObject({
        code: "agent_path_escape"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

});
