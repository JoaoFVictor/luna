import { z } from "zod";
import type {
  AgentRuntimeRequirement,
  AgentInstructionsAudit,
  RunAgentInput
} from "../../core/agent-runtime/contracts.js";
import { AgentRuntimeRequirementSchema } from "../../core/agent-runtime/contracts.js";
import type { ModelProfile } from "../../core/config/schemas.js";
import { ContextConfigSchema } from "../../core/config/schemas.js";
import { SkillPathSchema } from "../../core/skills/schemas.js";
import type { ResolvedSkillReference } from "../../core/skills/definition.js";
import type { ResolvedToolCatalog } from "../../core/tools/resolved-catalog.js";
import {
  contextIntakeFrom,
  type AgentContextCollection,
  type ContextFileCollection
} from "../../core/context/collect-context-contracts.js";
export { contextIntakeFrom } from "../../core/context/collect-context-contracts.js";

const NonEmptyStringSchema = z.string().min(1);
const CapabilityIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$|^[a-z0-9]$/);

const SubagentPolicyOverrideSchema = z
  .object({
    mode: z.enum(["read_only", "trusted_local_write"]).optional(),
    allow_tools: z.array(CapabilityIdSchema).optional()
  })
  .strict();

const SubagentReferenceObjectSchema = z
  .object({
    id: CapabilityIdSchema,
    policy: SubagentPolicyOverrideSchema.optional()
  })
  .strict();

const SubagentReferenceSchema = z.union([
  CapabilityIdSchema.transform((id) => ({ id })),
  SubagentReferenceObjectSchema
]);

export const AgentCapabilityFieldsSchema = z.object({
  skills: z.array(SkillPathSchema).optional(),
  tools: z.array(CapabilityIdSchema).optional(),
  mcp_servers: z.array(CapabilityIdSchema).optional(),
  subagents: z.array(SubagentReferenceSchema).optional()
});

export type AgentCapabilityFields = z.infer<typeof AgentCapabilityFieldsSchema>;

const AgentRuntimePreferencesSchema = z
  .object({
    preferred_runtime: NonEmptyStringSchema.optional(),
    runtime_order: z.array(NonEmptyStringSchema).optional()
  })
  .strict();

export const AgentMetadataSchema = z
  .object({
    id: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    model_profile: NonEmptyStringSchema,
    mode: z.enum(["read_only", "trusted_local_write"]),
    instructions_file: NonEmptyStringSchema,
    output_schema: NonEmptyStringSchema,
    context: ContextConfigSchema.optional(),
    runtime_requirements: z.array(AgentRuntimeRequirementSchema).optional(),
    runtime_preferences: AgentRuntimePreferencesSchema.optional(),
    metadata: z.record(z.unknown()).optional()
  })
  .extend(AgentCapabilityFieldsSchema.shape)
  .strict();

export type AgentMetadata = z.infer<typeof AgentMetadataSchema>;

export type AgentDefinition = AgentMetadata & {
  readonly directory: string;
  readonly instructionsPath: string;
  readonly outputSchemaPath: string;
  readonly instructions?: string;
  readonly outputSchema?: unknown;
};

export type LoadedAgentDefinition = AgentMetadata & {
  readonly directory: string;
  readonly instructionsPath: string;
  readonly outputSchemaPath: string;
  readonly instructions: string;
  readonly outputSchema: unknown;
};

export type AgentInstructionMode = AgentMetadata["mode"];

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

export type AgentInstructionInput = {
  readonly agent: {
    readonly id: string;
    readonly mode: AgentInstructionMode;
    readonly instructions: string;
  };
  readonly taskInput: Record<string, unknown>;
  readonly skills?: readonly ResolvedSkillReference[];
};

export type ProjectAgentRunInputOptions = {
  readonly run: RunAgentInput["run"];
  readonly node_id: string;
  readonly agent: LoadedAgentDefinition | AgentDefinitionProjection;
  readonly input: Record<string, unknown>;
  readonly output_schema: unknown;
  readonly model_profile: ModelProfile;
  readonly tools: ResolvedToolCatalog;
  readonly skills?: readonly ResolvedSkillReference[];
  readonly cwd?: string;
  readonly runtime_requirements?: readonly AgentRuntimeRequirement[];
  readonly signal?: AbortSignal;
  readonly events?: RunAgentInput["events"];
  readonly observability?: RunAgentInput["observability"];
};

export type AgentDefinitionProjection = {
  readonly id: string;
  readonly mode: AgentInstructionMode;
  readonly instructions: string;
  readonly tools?: readonly string[];
  readonly mcp_servers?: readonly string[];
  readonly skills?: readonly string[];
  readonly runtime_requirements?: readonly AgentRuntimeRequirement[];
};

export function agentDefinitionError(
  message: string,
  code: string,
  cause?: unknown
): Error & { code: string } {
  const error = new Error(message, { cause }) as Error & { code: string };
  error.code = code;

  return error;
}

export function assertNoDuplicateCapabilities({
  skills = [],
  tools = [],
  mcp_servers = [],
  subagents = []
}: AgentCapabilityFields): void {
  const subagentIds = subagents.map((subagent) => subagent.id);

  for (const [kind, ids] of [
    ["skills", skills],
    ["tools", tools],
    ["mcp_servers", mcp_servers],
    ["subagents", subagentIds]
  ] as const) {
    const seen = new Set<string>();

    for (const id of ids) {
      if (seen.has(id)) {
        throw agentDefinitionError(
          `Duplicate ${kind} capability: ${id}`,
          "agent_capability_duplicate"
        );
      }

      seen.add(id);
    }
  }
}

function contextAuditCollisionError(): Error & { code: string } {
  return agentDefinitionError(
    "Task input already contains context_audit; cannot attach collected context audit",
    "agent_context_audit_collision"
  );
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
  if (mode === "trusted_local_write") {
    return [
      "You are running in trusted host-local repository change mode.",
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

function renderSkills(skills: readonly ResolvedSkillReference[] | undefined): string {
  return (skills ?? [])
    .map((skill) =>
      [
        `## ${skill.name}`,
        skill.description,
        `Source: ${skill.skillMdPath}`,
        skill.content.trimEnd()
      ].join("\n\n")
    )
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
): {
  instructions: string;
  taskInput: Record<string, unknown>;
  instructionsAudit: AgentInstructionsAudit;
} {
  const taskInput = { ...input.taskInput };
  const context = contextIntakeFrom(taskInput.context);
  const sections: string[] = [];
  const instructionsAudit: AgentInstructionsAudit = {
    skills: (input.skills ?? []).map((skill) => ({
      name: skill.name,
      requested_path: skill.requestedPath
    }))
  };

  addSection(
    sections,
    "# Luna Runtime Instructions",
    runtimeInstructions(input.agent.mode)
  );
  addSection(sections, "# Skills", renderSkills(input.skills));
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
    taskInput,
    instructionsAudit
  };
}

function addRuntimeRequirements(
  target: AgentRuntimeRequirement[],
  requirements: readonly AgentRuntimeRequirement[] | undefined
): void {
  for (const requirement of requirements ?? []) {
    if (!target.includes(requirement)) {
      target.push(requirement);
    }
  }
}

export function projectAgentRunInput(
  options: ProjectAgentRunInputOptions
): RunAgentInput {
  const envelope = prepareAgentInstructionEnvelope({
    agent: {
      id: options.agent.id,
      mode: options.agent.mode,
      instructions: options.agent.instructions
    },
    taskInput: options.input,
    skills: options.skills
  });
  const runtimeRequirements: AgentRuntimeRequirement[] = [];
  addRuntimeRequirements(runtimeRequirements, options.agent.runtime_requirements);
  addRuntimeRequirements(runtimeRequirements, options.runtime_requirements);
  addRuntimeRequirements(runtimeRequirements, options.tools.runtime_requirements);

  return {
    run: options.run,
    node_id: options.node_id,
    agent_id: options.agent.id,
    agent_mode: options.agent.mode,
    instructions: envelope.instructions,
    instructions_audit: envelope.instructionsAudit,
    input: envelope.taskInput,
    output_schema: options.output_schema,
    model_profile: options.model_profile,
    tools: options.tools,
    context: contextIntakeFrom(options.input.context),
    cwd: options.cwd,
    runtime_requirements: runtimeRequirements,
    signal: options.signal,
    events: options.events,
    observability: options.observability
  };
}
