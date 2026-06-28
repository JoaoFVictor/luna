import {
  AgentRuntimeError,
  AgentRuntimeRequirementSchema,
  type AgentRuntimePort,
  type AgentRuntimeRequirement,
  type RunAgentOutput
} from "../../core/agent-runtime/contracts.js";
import {
  validateAgentRuntimeInput
} from "../../core/agent-runtime/validation.js";
import {
  runObservedAgent
} from "../../core/agent-runtime/observed-runner.js";
import { matchesJsonSchema } from "../../core/capabilities/json-schema.js";
import type { JsonSchemaLike } from "../../core/capabilities/json-schema-types.js";
import type { ModelProfile } from "../../core/config/schemas.js";
import type { ObservabilityRecorder } from "../../core/observability/tracing.js";
import type { RunHandle } from "../../core/runtime/run-handle.js";
import type { ResolvedSkillReference } from "../../core/skills/definition.js";
import type { ResolvedToolCatalog } from "../../core/tools/resolved-catalog.js";
import {
  projectAgentRunInput,
  type AgentDefinitionProjection,
  type LoadedAgentDefinition
} from "./agent-definition.js";

export type RunAgentNodeOptions = {
  readonly runtime: AgentRuntimePort;
  readonly run: RunHandle;
  readonly node_id: string;
  readonly agent: LoadedAgentDefinition | AgentDefinitionProjection;
  readonly model_profile: ModelProfile;
  readonly input: Record<string, unknown>;
  readonly output_schema: unknown;
  readonly tools: ResolvedToolCatalog | undefined;
  readonly skills?: readonly ResolvedSkillReference[];
  readonly cwd?: string;
  readonly runtime_requirements?: readonly AgentRuntimeRequirement[];
  readonly signal?: AbortSignal;
  readonly events?: Parameters<typeof projectAgentRunInput>[0]["events"];
  readonly observability?: ObservabilityRecorder;
  readonly emitEvent?: Parameters<typeof runObservedAgent>[0]["emitEvent"];
};

function agentNodeError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;

  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireOutputSchema(value: unknown): JsonSchemaLike {
  if (!isRecord(value)) {
    throw agentNodeError(
      "Agent node output_schema must resolve to a JSON schema object",
      "agent_output_schema_missing"
    );
  }

  return value as JsonSchemaLike;
}

function requireNonEmptyString(value: string, label: string, code: string): void {
  if (value.trim() === "") {
    throw agentNodeError(`${label} must be a non-empty string`, code);
  }
}

function requireResolvedToolCatalog({
  agent,
  tools
}: {
  readonly agent: LoadedAgentDefinition | AgentDefinitionProjection;
  readonly tools: ResolvedToolCatalog | undefined;
}): ResolvedToolCatalog {
  if (
    tools === undefined ||
    !Array.isArray(tools.tools) ||
    !Array.isArray(tools.runtime_requirements)
  ) {
    throw agentNodeError(
      "Agent node requires a resolved tool catalog before execution",
      "agent_tool_catalog_unresolved"
    );
  }

  const resolvedToolIds = new Set(tools.tools.map((tool) => tool.id));
  for (const toolId of "tools" in agent ? agent.tools ?? [] : []) {
    if (!resolvedToolIds.has(toolId)) {
      throw agentNodeError(
        `Agent declared unresolved tool capability: ${toolId}`,
        "agent_tool_catalog_missing_tool"
      );
    }
  }

  const resolvedMcpServerIds = new Set(
    tools.mcp_policy?.servers.map((server) => server.id) ?? []
  );
  for (const serverId of "mcp_servers" in agent ? agent.mcp_servers ?? [] : []) {
    if (!resolvedMcpServerIds.has(serverId)) {
      throw agentNodeError(
        `Agent declared unresolved MCP server capability: ${serverId}`,
        "agent_tool_catalog_missing_mcp_server"
      );
    }
  }

  return tools;
}

function requireResolvedSkills({
  agent,
  skills
}: {
  readonly agent: LoadedAgentDefinition | AgentDefinitionProjection;
  readonly skills: readonly ResolvedSkillReference[] | undefined;
}): readonly ResolvedSkillReference[] | undefined {
  const declaredSkills = "skills" in agent ? agent.skills ?? [] : [];
  if (declaredSkills.length === 0) {
    return skills;
  }

  if (skills === undefined) {
    throw agentNodeError(
      "Agent node requires resolved skills before execution",
      "agent_skills_unresolved"
    );
  }

  const resolvedPaths = new Set(skills.map((skill) => skill.requestedPath));
  const resolvedNames = new Set(skills.map((skill) => skill.name));
  for (const skillPath of declaredSkills) {
    if (!resolvedPaths.has(skillPath) && !resolvedNames.has(skillPath)) {
      throw agentNodeError(
        `Agent declared unresolved skill capability: ${skillPath}`,
        "agent_skills_missing_skill"
      );
    }
  }

  return skills;
}

function requireRuntimeRequirements(
  requirements: readonly unknown[] | undefined
): void {
  for (const requirement of requirements ?? []) {
    const parsed = AgentRuntimeRequirementSchema.safeParse(requirement);
    if (!parsed.success) {
      throw agentNodeError(
        `Unsupported agent runtime requirement: ${String(requirement)}`,
        "agent_runtime_requirements_invalid"
      );
    }
  }
}

function isJsonExpressionObject(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.expression === "string"
  );
}

function validateOutput(schema: JsonSchemaLike, output: unknown): void {
  if (!matchesJsonSchema(schema, output, { isExpressionObject: isJsonExpressionObject })) {
    throw new AgentRuntimeError(
      "runtime_output_schema_invalid",
      "Agent runtime output does not match the node output schema"
    );
  }
}

export async function runAgentNode(
  options: RunAgentNodeOptions
): Promise<RunAgentOutput> {
  requireNonEmptyString(options.node_id, "Agent node id", "agent_node_id_invalid");
  requireNonEmptyString(options.agent.id, "Agent id", "agent_id_invalid");
  requireRuntimeRequirements(options.agent.runtime_requirements);
  requireRuntimeRequirements(options.runtime_requirements);
  const outputSchema = requireOutputSchema(options.output_schema);
  const tools = requireResolvedToolCatalog({
    agent: options.agent,
    tools: options.tools
  });
  const skills = requireResolvedSkills({
    agent: options.agent,
    skills: options.skills
  });
  const input = projectAgentRunInput({
    run: options.run,
    node_id: options.node_id,
    agent: options.agent,
    input: options.input,
    output_schema: outputSchema,
    model_profile: options.model_profile,
    tools,
    skills,
    cwd: options.cwd,
    runtime_requirements: options.runtime_requirements,
    signal: options.signal,
    events: options.events,
    observability: options.observability
  });

  await validateAgentRuntimeInput(input, options.runtime.describe());
  await options.runtime.validate(input);
  const output = await runObservedAgent({
    runtime: options.runtime,
    input,
    observability: options.observability,
    emitEvent: options.emitEvent
  });
  validateOutput(outputSchema, output.output);

  return output;
}
