import { describe, expect, it } from "vitest";
import {
  type AgentInstructionMode,
  contextIntakeFrom,
  prepareAgentInstructionEnvelope
} from "../../src/core/agents/instruction-stack.js";

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

const readOnlyStructuredOutputInstruction =
  "Use only the provided workflow input and return structured output matching the configured schema.";

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
    expect(envelope.instructions).toContain(
      readOnlyStructuredOutputInstruction
    );

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

    expect(envelope.taskInput).toEqual({
      issue: "LUNA-1",
      context_audit: {
        agent: {
          id: "implementer",
          configured: ["local.md"],
          read: [{ path: "local.md", bytes: 20 }],
          missing: [{ path: "missing-agent.md" }],
          skipped: [{ path: "dir", reason: "not_file" }]
        },
        repository: {
          configured: ["AGENTS.md", "README.md"],
          read: [{ path: "AGENTS.md", bytes: 25 }],
          missing: [{ path: "README.md" }],
          skipped: [{ path: "large.md", reason: "too_large", bytes: 100000 }]
        }
      }
    });
    expect(JSON.stringify(envelope.taskInput)).not.toContain("content");
    expect(JSON.stringify(envelope.taskInput)).not.toContain(
      "Agent instructions."
    );
    expect(JSON.stringify(envelope.taskInput)).not.toContain(
      "Repository instructions."
    );
  });

  it("does not include context from another agent", () => {
    const envelope = prepare({ context: collectContext });

    expect(envelope.instructions).toContain("Agent instructions.");
    expect(envelope.instructions).not.toContain("Reviewer only.");
    expect(envelope.taskInput.context_audit).toEqual(
      expect.objectContaining({
        agent: expect.objectContaining({ id: "implementer" })
      })
    );
  });

  it("preserves ordinary input.context when it is not collect_context", () => {
    const context = { issue: "LUNA-1", notes: ["keep me"] };
    const envelope = prepare({ context, count: 2 });

    expect(envelope.taskInput).toEqual({ context, count: 2 });
    expect(envelope.instructions).not.toContain("# Agent Context");
    expect(envelope.instructions).not.toContain("# Repository Context");
  });

  it("does not confuse collect_context-like payloads missing root or read.content", () => {
    expect(
      contextIntakeFrom({
        kind: "luna.collect_context.v1",
        repository: {
          configured: [],
          read: [],
          missing: [],
          skipped: []
        },
        agents: []
      })
    ).toBeUndefined();

    expect(
      contextIntakeFrom({
        kind: "luna.collect_context.v1",
        repository: {
          root: "/repo",
          configured: [],
          read: [{ path: "AGENTS.md", bytes: 25 }],
          missing: [],
          skipped: []
        },
        agents: []
      })
    ).toBeUndefined();
  });

  it("does not promote context-shaped task payloads without collect_context kind", () => {
    const context = {
      repository: repositoryContext,
      agents: [currentAgentContext]
    };
    const envelope = prepare({ context });

    expect(contextIntakeFrom(context)).toBeUndefined();
    expect(envelope.taskInput).toEqual({ context });
    expect(envelope.instructions).not.toContain("# Agent Context");
    expect(envelope.instructions).not.toContain("# Repository Context");
  });

  it("throws a clear coded error when context_audit would collide", () => {
    expect(() =>
      prepare({
        context: collectContext,
        context_audit: { existing: true }
      })
    ).toThrow("Task input already contains context_audit");
    expect(() =>
      prepare({
        context: collectContext,
        context_audit: { existing: true }
      })
    ).toThrow(expect.objectContaining({ code: "agent_context_audit_collision" }));
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

  it("uses write-mode runtime instructions for trusted_host_local_write", () => {
    const envelope = prepare({ context: collectContext }, "trusted_host_local_write");

    expect(envelope.instructions).toContain("trusted host-local write mode");
    expect(envelope.instructions).toContain(
      "Make changes only in the configured worktree"
    );
    expect(envelope.instructions).toContain(
      "Return structured output matching the configured schema."
    );
  });
});
