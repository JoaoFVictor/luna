import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AgentInstructionMode,
  prepareAgentInstructionEnvelope
} from "../../src/capabilities/agents/agent-definition.js";
import { resolveAgentSkills } from "../../src/capabilities/agents/agent-envelope.js";

const repositoryContext = {
  root: "/repo",
  configured: ["AGENTS.md", "README.md"],
  read: [
    {
      path: "AGENTS.md",
      bytes: 25,
      content: "Repository instructions.\n"
    }
  ],
  missing: [{ path: "README.md" }],
  skipped: [{ path: "large.md", reason: "too_large", bytes: 100000 }]
} as const;

const currentAgentContext = {
  id: "implementer",
  root: "/agents/implementer",
  configured: ["local.md"],
  read: [
    {
      path: "local.md",
      bytes: 20,
      content: "Agent instructions.\n"
    }
  ],
  missing: [{ path: "missing-agent.md" }],
  skipped: [{ path: "dir", reason: "not_file" }]
} as const;

const otherAgentContext = {
  id: "reviewer",
  root: "/agents/reviewer",
  configured: ["review.md"],
  read: [
    {
      path: "review.md",
      bytes: 18,
      content: "Reviewer only.\n"
    }
  ],
  missing: [],
  skipped: []
} as const;

const collectContext = {
  kind: "luna.collect_context.v1",
  repository: repositoryContext,
  agents: [otherAgentContext, currentAgentContext]
} as const;

function prepare(
  taskInput: Record<string, unknown>,
  mode: AgentInstructionMode = "read_only"
) {
  return prepareAgentInstructionEnvelope({
    agent: {
      id: "implementer",
      mode,
      instructions: "Implement the task.\n"
    },
    taskInput
  });
}

describe("agent instruction stack", () => {
  it("promotes current agent context before repository context", () => {
    const envelope = prepare({ context: collectContext, issue: "LUNA-1" });

    expect(envelope.instructions).toContain("# Luna Runtime Instructions");
    expect(envelope.instructions).toContain("# Agent Instructions");
    expect(envelope.instructions).toContain("# Agent Context");
    expect(envelope.instructions).toContain("# Repository Context");
    expect(envelope.instructions).toContain("Implement the task.");
    expect(envelope.instructions).toContain("Agent instructions.");
    expect(envelope.instructions).toContain("Repository instructions.");
    expect(envelope.instructions).not.toContain("Reviewer only.");

    expect(envelope.instructions.indexOf("# Luna Runtime Instructions")).toBeLessThan(
      envelope.instructions.indexOf("# Agent Instructions")
    );
    expect(envelope.instructions.indexOf("# Agent Instructions")).toBeLessThan(
      envelope.instructions.indexOf("# Agent Context")
    );
    expect(envelope.instructions.indexOf("# Agent Context")).toBeLessThan(
      envelope.instructions.indexOf("# Repository Context")
    );
    expect(envelope.instructions.indexOf("Agent instructions.")).toBeLessThan(
      envelope.instructions.indexOf("Repository instructions.")
    );
  });

  it("removes raw collect_context from taskInput and adds context_audit without content", () => {
    const envelope = prepare({ context: collectContext, issue: "LUNA-1" });

    expect(envelope.taskInput).toMatchObject({
      issue: "LUNA-1",
      context_audit: {
        agent: { id: "implementer" },
        repository: {}
      }
    });
    expect(envelope.taskInput).not.toHaveProperty("context");
    expect(JSON.stringify(envelope.taskInput.context_audit)).not.toContain(
      "Agent instructions."
    );
    expect(JSON.stringify(envelope.taskInput.context_audit)).not.toContain(
      "Repository instructions."
    );
  });

  it("preserves ordinary input.context when it is not collect_context", () => {
    const context = { issue: "LUNA-1", notes: ["keep me"] };
    const envelope = prepare({ context, count: 2 });

    expect(envelope.taskInput).toEqual({ context, count: 2 });
    expect(envelope.instructions).not.toContain("# Agent Context");
    expect(envelope.instructions).not.toContain("# Repository Context");
  });

  it("throws a clear coded error when context_audit would collide", () => {
    let thrown: unknown;
    try {
      prepare({
        context: collectContext,
        context_audit: { existing: true }
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(
      expect.objectContaining({
        code: "agent_context_audit_collision"
      })
    );
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Task input already contains context_audit");
  });

  it("uses repository context when the current agent has no context", () => {
    const envelope = prepare({
      context: {
        kind: "luna.collect_context.v1",
        repository: repositoryContext,
        agents: [otherAgentContext]
      }
    });

    expect(envelope.instructions).not.toContain("# Agent Context");
    expect(envelope.instructions).toContain("# Repository Context");
    expect(envelope.instructions).toContain("Repository instructions.");
    expect(envelope.taskInput).toEqual({
      context_audit: {
        repository: {
          configured: ["AGENTS.md", "README.md"],
          read: [{ path: "AGENTS.md", bytes: 25 }],
          missing: [{ path: "README.md" }],
          skipped: [{ path: "large.md", reason: "too_large", bytes: 100000 }]
        }
      }
    });
  });

  it("resolves repository skills from the prepared workspace root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-agent-skills-"));

    try {
      const sourceRoot = path.join(root, "source");
      const workspaceRoot = path.join(root, "workspace");
      const agentDirectory = path.join(root, "agents", "reviewer");
      await mkdir(path.join(sourceRoot, "skills"), { recursive: true });
      await mkdir(path.join(workspaceRoot, "skills"), { recursive: true });
      await mkdir(agentDirectory, { recursive: true });
      await writeFile(
        path.join(sourceRoot, "skills", "review.md"),
        [
          "---",
          "name: repo-review",
          "description: Source repo review skill.",
          "---",
          "",
          "SOURCE REPO SKILL SHOULD NOT BE USED."
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        path.join(workspaceRoot, "skills", "review.md"),
        [
          "---",
          "name: repo-review",
          "description: Workspace review skill.",
          "---",
          "",
          "WORKSPACE SKILL WAS USED."
        ].join("\n"),
        "utf8"
      );

      const skills = await resolveAgentSkills({
        skillSources: {
          repository: { root: sourceRoot, skills: ["skills/review.md"] },
          agentDirectory
        },
        workspace: { path: workspaceRoot }
      });

      expect(skills?.[0]?.content).toContain("WORKSPACE SKILL WAS USED.");
      expect(skills?.[0]?.content).not.toContain("SOURCE REPO SKILL SHOULD NOT BE USED.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
