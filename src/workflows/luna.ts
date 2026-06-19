import { readFile } from "node:fs/promises";
import { createAgent, type FlueContext } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import * as v from "valibot";
import type { GenericSchema } from "valibot";
import {
  runAgentLoopStateMachine,
  type RunWritableAgentInput
} from "../core/agent-loop-runner.js";
import {
  runConfiguredWorkflow,
  type ConfiguredWorkflowResult,
  type RunAgentLoopStepOptions,
  type RunAgentStepOptions
} from "../core/configured-workflow-runner.js";
import {
  resolveFlueAgentCapabilities,
  type ResolvedFlueAgentCapabilities
} from "../core/flue-agent-capabilities.js";
import { loadMcpConfig } from "../core/mcp-config.js";
import { registerConfiguredPiOAuthProviders } from "../core/pi-auth.js";
import type { Invocation } from "../core/types.js";
import { runValidationCommands } from "../core/validation-runner.js";
import { collectWorktreeDiff } from "../core/worktree-diff-collector.js";

function codedError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function promptBody(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function allowlistedEnv(
  allowlist: readonly string[]
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};

  for (const name of allowlist) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }

  return env;
}

function workspacePath(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("path" in value)) {
    return undefined;
  }

  const pathValue = (value as { path?: unknown }).path;
  return typeof pathValue === "string" ? pathValue : undefined;
}

function repositoryPath(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("path" in value)) {
    return undefined;
  }

  const pathValue = (value as { path?: unknown }).path;
  return typeof pathValue === "string" ? pathValue : undefined;
}

function capabilityCwdFor(options: RunAgentStepOptions): string {
  const path =
    workspacePath(options.state.workspace) ??
    repositoryPath(options.state.repository);

  if (path !== undefined) {
    return path;
  }

  if ((options.agent.tools ?? []).length === 0) {
    return process.cwd();
  }

  throw codedError(
    `Agent ${options.agent.id} declares local tools but no repository or workspace path is available`,
    "agent_tool_cwd_missing"
  );
}

type JsonSchema = {
  type?: unknown;
  enum?: unknown;
  minLength?: unknown;
  minimum?: unknown;
  items?: unknown;
  properties?: unknown;
  required?: unknown;
  additionalProperties?: unknown;
};

function jsonSchemaError(message: string): Error & { code: string } {
  return codedError(message, "agent_output_schema_unsupported");
}

function requiredProperties(schema: JsonSchema): Set<string> {
  if (schema.required === undefined) {
    return new Set();
  }

  if (
    !Array.isArray(schema.required) ||
    !schema.required.every((item) => typeof item === "string")
  ) {
    throw jsonSchemaError("JSON Schema required must be a string array");
  }

  return new Set(schema.required);
}

function enumSchema(values: unknown): GenericSchema | undefined {
  if (values === undefined) {
    return undefined;
  }

  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    !values.every((item) => typeof item === "string")
  ) {
    throw jsonSchemaError("Only non-empty string enum schemas are supported");
  }

  return v.picklist(values as [string, ...string[]]);
}

function stringSchema(schema: JsonSchema): GenericSchema {
  const schemaEnum = enumSchema(schema.enum);
  if (schemaEnum !== undefined) {
    return schemaEnum;
  }

  const base = v.string();
  if (typeof schema.minLength === "number") {
    return v.pipe(base, v.minLength(schema.minLength));
  }

  return base;
}

function numberSchema(schema: JsonSchema, integer: boolean): GenericSchema {
  const base = integer ? v.pipe(v.number(), v.integer()) : v.number();
  if (typeof schema.minimum === "number") {
    return v.pipe(base, v.minValue(schema.minimum));
  }

  return base;
}

function objectSchema(schema: JsonSchema): GenericSchema {
  if (
    schema.properties !== undefined &&
    (typeof schema.properties !== "object" ||
      schema.properties === null ||
      Array.isArray(schema.properties))
  ) {
    throw jsonSchemaError("JSON Schema properties must be an object");
  }

  const required = requiredProperties(schema);
  const entries: Record<string, GenericSchema> = {};

  for (const [key, value] of Object.entries(
    (schema.properties ?? {}) as Record<string, unknown>
  )) {
    const propertySchema = schemaFromJson(value);
    entries[key] = required.has(key) ? propertySchema : v.optional(propertySchema);
  }

  return schema.additionalProperties === false
    ? v.strictObject(entries)
    : v.object(entries);
}

function schemaFromJson(value: unknown): GenericSchema {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw jsonSchemaError("JSON Schema must be an object");
  }

  const schema = value as JsonSchema;
  if (schema.enum !== undefined) {
    return enumSchema(schema.enum) as GenericSchema;
  }

  if (schema.type === "string") {
    return stringSchema(schema);
  }

  if (schema.type === "number") {
    return numberSchema(schema, false);
  }

  if (schema.type === "integer") {
    return numberSchema(schema, true);
  }

  if (schema.type === "boolean") {
    return v.boolean();
  }

  if (schema.type === "array") {
    if (schema.items === undefined) {
      throw jsonSchemaError("JSON Schema arrays must define items");
    }

    return v.array(schemaFromJson(schema.items));
  }

  if (schema.type === "object") {
    return objectSchema(schema);
  }

  throw jsonSchemaError(`Unsupported JSON Schema type: ${String(schema.type)}`);
}

async function resultSchema(outputSchemaPath: string): Promise<GenericSchema> {
  return schemaFromJson(JSON.parse(await readFile(outputSchemaPath, "utf8")));
}

function fakeAgentOutput(agentId: string): unknown {
  if (agentId === "review-planner") {
    return {
      summary: "Deterministic test review plan.",
      focus_areas: ["changed files"],
      files_to_review: []
    };
  }

  if (agentId === "code-reviewer") {
    return {
      findings: [],
      summary: "No deterministic findings."
    };
  }

  if (agentId === "acceptance-reviewer") {
    return {
      decision: "approve",
      summary: "Deterministic fake review passed.",
      blocking_findings: []
    };
  }

  throw codedError(`No fake output configured for ${agentId}`, "fake_agent_missing");
}

async function runFlueAgentStep(
  ctx: FlueContext<Invocation>,
  options: RunAgentStepOptions
): Promise<unknown> {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.LUNA_FAKE_REVIEW_NODES === "1"
  ) {
    return fakeAgentOutput(options.agent.id);
  }

  const capabilityCwd = capabilityCwdFor(options);
  const capabilities = await resolveFlueAgentCapabilities({
    agent: options.agent,
    cwd: capabilityCwd,
    agentsRoot: options.agentsRoot,
    modelProfiles: options.modelProfiles,
    mcpConfig: options.mcpConfig,
    env: process.env
  });

  try {
    const agent = createAgent(async () => ({
      description: options.agent.description,
      instructions: await readFile(options.agent.instructionsPath, "utf8"),
      skills: capabilities.skills,
      tools: capabilities.tools,
      subagents: capabilities.subagents,
      ...options.model
    }));
    const harness = await ctx.init(agent, { name: options.agent.id });
    const session = await harness.session();
    const response = await session.prompt(
      [
        options.agent.description,
        "Use only the provided workflow input and return structured output matching the configured schema.",
        promptBody(options.input)
      ].join("\n\n"),
      {
        result: await resultSchema(options.agent.outputSchemaPath),
        ...options.model
      }
    );

    return response.data;
  } finally {
    await capabilities.close();
  }
}

function writableAgentPrompt(
  options: RunAgentLoopStepOptions,
  input: RunWritableAgentInput
): string {
  return [
    options.agent.description,
    "You are running in trusted host-local mode. Make changes only in the configured worktree and return structured output matching the configured schema.",
    promptBody({
      phase: input.phase,
      attempt: input.attempt,
      workflow_input: options.input,
      previous_validation: input.previousValidation,
      previous_error: input.previousError,
      diff_summary: input.diffSummary
    })
  ].join("\n\n");
}

async function runWritableAgent(
  ctx: FlueContext<Invocation>,
  options: RunAgentLoopStepOptions,
  input: RunWritableAgentInput,
  capabilities: ResolvedFlueAgentCapabilities
): Promise<unknown> {
  const agent = createAgent(async () => ({
    description: options.agent.description,
    instructions: await readFile(options.agent.instructionsPath, "utf8"),
    skills: capabilities.skills,
    tools: capabilities.tools,
    subagents: capabilities.subagents,
    cwd: options.sandbox.cwd,
    sandbox: local({
      cwd: options.sandbox.cwd,
      env: allowlistedEnv(options.sandbox.env_allowlist)
    }),
    ...options.model
  }));
  const harness = await ctx.init(agent, { name: options.agent.id });
  const session = await harness.session();
  const response = await session.prompt(writableAgentPrompt(options, input), {
    result: await resultSchema(options.agent.outputSchemaPath),
    ...options.model
  });

  return response.data;
}

async function runFlueAgentLoopStep(
  ctx: FlueContext<Invocation>,
  options: RunAgentLoopStepOptions
): Promise<unknown> {
  if (options.sandbox.type !== "trusted_host_local") {
    throw codedError(
      `Unsupported agent_loop sandbox type: ${String(options.sandbox.type)}`,
      "agent_loop_sandbox_unsupported"
    );
  }

  if (options.agent.mode !== "trusted_host_local_write") {
    throw codedError(
      `Agent ${options.agent.id} must declare trusted_host_local_write for trusted_host_local execution`,
      "trusted_host_local_agent_mode_required"
    );
  }

  const capabilities = await resolveFlueAgentCapabilities({
    agent: options.agent,
    cwd: options.sandbox.cwd,
    agentsRoot: options.agentsRoot,
    modelProfiles: options.modelProfiles,
    mcpConfig: options.mcpConfig,
    env: process.env
  });

  try {
    return await runAgentLoopStateMachine({
      cwd: options.sandbox.cwd,
      prompt: options.input,
      repairAttempts: options.repair.attempts,
      dependencies: {
        runWritableAgent: async (input) =>
          await runWritableAgent(ctx, options, input, capabilities),
        runValidation: async () =>
          await runValidationCommands({
            cwd: options.sandbox.cwd,
            commands: options.validation.commands,
            maxOutputBytes: options.validation.max_output_bytes
          }),
        collectDiffSummary: async () =>
          await collectWorktreeDiff({
            cwd: options.sandbox.cwd,
            maxDiffBytes: options.validation.max_output_bytes
          })
      }
    });
  } finally {
    await capabilities.close();
  }
}

export async function runWithFlue(
  ctx: FlueContext<Invocation>
): Promise<ConfiguredWorkflowResult> {
  const configRoot = process.env.LUNA_CONFIG_ROOT ?? "config";
  await registerConfiguredPiOAuthProviders({ configRoot });
  const mcpConfig = await loadMcpConfig(configRoot);

  return await runConfiguredWorkflow({
    invocation: ctx.payload,
    configRoot,
    dependencies: {
      runAgentStep: async (agentStepOptions) =>
        await runFlueAgentStep(ctx, { ...agentStepOptions, mcpConfig }),
      runAgentLoopStep: async (agentLoopStepOptions) =>
        await runFlueAgentLoopStep(ctx, {
          ...agentLoopStepOptions,
          mcpConfig
        })
    }
  });
}

export async function run(
  ctx: FlueContext<Invocation>
): Promise<ConfiguredWorkflowResult> {
  return await runWithFlue(ctx);
}
