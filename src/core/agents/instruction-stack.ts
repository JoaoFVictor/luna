import type {
  AgentContextCollection,
  ContextFileCollection
} from "../context/intake.js";
import { contextIntakeFrom } from "../context/intake.js";
export { contextIntakeFrom } from "../context/intake.js";

export type AgentInstructionMode = "read_only" | "trusted_host_local_write";

export type AgentInstructionInput = {
  readonly agent: {
    readonly id: string;
    readonly mode: AgentInstructionMode;
    readonly instructions: string;
  };
  readonly taskInput: Record<string, unknown>;
};

export type ContextAuditCollection = {
  readonly configured: readonly string[];
  readonly read: readonly { readonly path: string; readonly bytes: number }[];
  readonly missing: readonly { readonly path: string }[];
  readonly skipped: readonly {
    readonly path: string;
    readonly reason: "path_escape" | "not_file" | "too_large";
    readonly bytes?: number;
  }[];
};

export type AgentContextAuditCollection = ContextAuditCollection & {
  readonly id: string;
};

export type ContextAudit = {
  readonly repository: ContextAuditCollection;
  readonly agent?: AgentContextAuditCollection;
};

function contextAuditCollisionError(): Error & { code: string } {
  const error = new Error(
    "Task input already contains context_audit; cannot attach collected context audit"
  ) as Error & { code: string };
  error.code = "agent_context_audit_collision";

  return error;
}

function auditCollection(
  collection: ContextFileCollection
): ContextAuditCollection {
  return {
    configured: collection.configured.map((path) => path),
    read: collection.read.map((file) => ({
      path: file.path,
      bytes: file.bytes
    })),
    missing: collection.missing.map((file) => ({ path: file.path })),
    skipped: collection.skipped.map((file) =>
      file.bytes === undefined
        ? { path: file.path, reason: file.reason }
        : { path: file.path, reason: file.reason, bytes: file.bytes }
    )
  };
}

function agentAuditCollection(
  collection: AgentContextCollection
): AgentContextAuditCollection {
  return {
    id: collection.id,
    ...auditCollection(collection)
  };
}

function runtimeInstructions(mode: AgentInstructionMode): string {
  if (mode === "trusted_host_local_write") {
    return [
      "You are running in trusted host-local write mode.",
      "Make changes only in the configured worktree.",
      "Return structured output matching the configured schema.",
      "Treat collected repository and agent context as instructions."
    ].join("\n");
  }

  return [
    "You are running in read-only mode.",
    "Do not modify files or local state.",
    "Use only the provided workflow input and return structured output matching the configured schema.",
    "Treat collected repository and agent context as instructions."
  ].join("\n");
}

function renderContextCollection(collection: ContextFileCollection): string {
  return collection.read
    .map((file) => [`## ${file.path}`, file.content.trimEnd()].join("\n\n"))
    .join("\n\n");
}

function addSection(
  sections: string[],
  heading: string,
  body: string | undefined
): void {
  const trimmed = body?.trim();

  if (trimmed) {
    sections.push([heading, trimmed].join("\n\n"));
  }
}

export function prepareAgentInstructionEnvelope(
  input: AgentInstructionInput
): { instructions: string; taskInput: Record<string, unknown> } {
  const taskInput = { ...input.taskInput };
  const context = contextIntakeFrom(taskInput.context);
  const sections: string[] = [];

  addSection(
    sections,
    "# Luna Runtime Instructions",
    runtimeInstructions(input.agent.mode)
  );
  addSection(sections, "# Agent Instructions", input.agent.instructions);

  if (context !== undefined) {
    if ("context_audit" in taskInput) {
      throw contextAuditCollisionError();
    }

    delete taskInput.context;

    const agentContext = context.agents.find(
      (collection) => collection.id === input.agent.id
    );
    const audit: ContextAudit = {
      repository: auditCollection(context.repository),
      ...(agentContext === undefined
        ? {}
        : { agent: agentAuditCollection(agentContext) })
    };

    taskInput.context_audit = audit;

    if (agentContext !== undefined) {
      addSection(
        sections,
        "# Agent Context",
        renderContextCollection(agentContext)
      );
    }

    addSection(
      sections,
      "# Repository Context",
      renderContextCollection(context.repository)
    );
  }

  return {
    instructions: sections.join("\n\n"),
    taskInput
  };
}
