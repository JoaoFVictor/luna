import { readFile } from "node:fs/promises";
import {
  createAgent,
  type FlueContext,
  type PromptModel,
  type PromptUsage
} from "@flue/runtime";
import { local } from "@flue/runtime/node";
import * as v from "valibot";
import type { GenericSchema } from "valibot";
import {
  runAgentLoopStateMachine,
  type RunWritableAgentInput
} from "../../agents/loop-runner.js";
import {
  contextIntakeFrom,
  prepareAgentInstructionEnvelope
} from "../../agents/instruction-stack.js";
import type {
  RunAgentLoopStepOptions,
  RunAgentStepOptions
} from "../../configured-workflow/runner.js";
import {
  resolveFlueAgentCapabilities,
  type ResolvedFlueAgentCapabilities
} from "./capabilities.js";
import {
  toFlueModelOptions,
  toFluePromptOptions
} from "./model-options.js";
import type { McpConfig } from "../../config/mcp.js";
import { customEvent } from "../../observability/luna-observability.js";
import { sanitizeJsonObject } from "../../observability/sanitize.js";
import {
  recordPromptOperation,
  recordPromptUsage,
  recordPromptUsageMissing,
  writeSummaryBestEffort
} from "../../observability/summary.js";
import { usageFromFlueResponse } from "./observability.js";
import type { Invocation } from "../../invocation/types.js";
import { runValidationCommands } from "../../validation/runner.js";
import { collectWorktreeDiff } from "../../git/diff/worktree-diff.js";
import {
  type RetryErrorCode,
  retryDecision,
  type RetryPolicy
} from "../../retry/policy.js";
import {
  classifyFluePromptError,
  fluePromptFailureHint,
  readOnlyFluePromptRetryPolicy,
  writeModeFluePromptRetryPolicy
} from "./retry.js";

type FlueAgentRunnerOptions = {
  ctx: FlueContext<Invocation>;
  mcpConfig?: McpConfig;
};

type AgentInstructionEnvelope = ReturnType<
  typeof prepareAgentInstructionEnvelope
>;

export type FlueAgentRunner = {
  runAgentStep(options: RunAgentStepOptions): Promise<unknown>;
  runAgentLoopStep(options: RunAgentLoopStepOptions): Promise<unknown>;
};

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

type PromptResponseWithUsage = {
  usage?: PromptUsage;
  model?: PromptModel;
};

function promptErrorAttributes(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: (error as { code?: unknown }).code
    };
  }

  return error;
}

async function emitPromptEvent(
  options: RunAgentStepOptions | RunAgentLoopStepOptions,
  level: "info" | "warn" | "error",
  event: string,
  data: Record<string, unknown>,
  outcome?: { status: "started" | "succeeded" | "failed" | "skipped"; code?: string }
): Promise<void> {
  if (options.observability === undefined) {
    return;
  }

  await options.observability.emit(
    customEvent({
      ...options.observability.eventContext(level),
      type: event,
      step: { id: options.node.id, type: options.node.type },
      outcome,
      data: sanitizeJsonObject({
        agent_id: options.agent.id,
        ...data
      })
    })
  );
}

async function recordPromptCompletion(
  options: RunAgentStepOptions | RunAgentLoopStepOptions,
  promptId: string,
  startedAtMs: number,
  response: PromptResponseWithUsage | undefined
): Promise<void> {
  const durationMs = Date.now() - startedAtMs;
  recordPromptOperation(options.summary, { durationMs });
  const usage = usageFromFlueResponse({
    promptId,
    modelProfile: options.agent.model_profile,
    response
  });

  try {
    if (usage === undefined) {
      recordPromptUsageMissing(options.summary);
      await emitPromptEvent(
        options,
        "warn",
        "luna.prompt.usage_missing",
        {
          prompt_id: promptId
        },
        { status: "succeeded" }
      );
    } else {
      recordPromptUsage(options.summary, usage);
    }

    await emitPromptEvent(
      options,
      "info",
      "luna.prompt.finished",
      {
        prompt_id: promptId,
        duration_ms: durationMs
      },
      { status: "succeeded" }
    );
  } finally {
    await writeSummaryBestEffort(options.artifactStore, options.summary);
  }
}

async function recordPromptFailure(
  options: RunAgentStepOptions | RunAgentLoopStepOptions,
  promptId: string,
  startedAtMs: number,
  error: unknown
): Promise<void> {
  const durationMs = Date.now() - startedAtMs;
  const hint = fluePromptFailureHint(error);
  recordPromptOperation(options.summary, { durationMs });
  try {
    await emitPromptEvent(
      options,
      "error",
      "luna.prompt.failed",
      {
        prompt_id: promptId,
        duration_ms: durationMs,
        ...(hint === undefined ? {} : { hint }),
        error: promptErrorAttributes(error)
      },
      { status: "failed" }
    );
  } finally {
    await writeSummaryBestEffort(options.artifactStore, options.summary);
  }
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

function readOnlyRetryPolicy(options: RunAgentStepOptions): RetryPolicy {
  return readOnlyFluePromptRetryPolicy(options.node.retry);
}

function writeModeRetryPolicy(options: RunAgentLoopStepOptions): RetryPolicy {
  return writeModeFluePromptRetryPolicy(options.node.retry);
}

async function emitPromptRetryEvent(
  options: RunAgentStepOptions | RunAgentLoopStepOptions,
  error: unknown,
  attempt: number,
  retryPolicy: RetryPolicy,
  errorCode: RetryErrorCode,
  retryDelayMs: number
): Promise<void> {
  const hint = fluePromptFailureHint(error);

  await emitPromptEvent(
    options,
    "warn",
    "luna.agent_step.retrying",
    {
      attempt,
      next_attempt: attempt + 1,
      max_attempts: retryPolicy.maxAttempts,
      retry_delay_ms: retryDelayMs,
      error_code: errorCode,
      ...(hint === undefined ? {} : { hint }),
      error: promptErrorAttributes(error)
    },
    { status: "skipped", code: errorCode }
  );
}

function agentSandboxFor(options: RunAgentStepOptions):
  | {
      cwd: string;
      sandbox: ReturnType<typeof local>;
    }
  | {} {
  const cwd =
    workspacePath(options.state.workspace) ??
    repositoryPath(options.state.repository);

  return cwd === undefined ? {} : { cwd, sandbox: local({ cwd, env: {} }) };
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

type PromptSession = {
  prompt(
    text: string,
    options: Record<string, unknown>
  ): Promise<PromptResponseWithUsage & { data?: unknown }>;
};

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPromptWithRetry({
  options,
  session,
  promptId,
  text,
  promptOptions,
  retryPolicy,
  promptData = {}
}: {
  options: RunAgentStepOptions | RunAgentLoopStepOptions;
  session: PromptSession;
  promptId: string;
  text: string;
  promptOptions: Record<string, unknown>;
  retryPolicy: RetryPolicy;
  promptData?: Record<string, unknown>;
}): Promise<PromptResponseWithUsage & { data?: unknown }> {
  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
    const startedAtMs = Date.now();
    await emitPromptEvent(
      options,
      "info",
      "luna.prompt.started",
      {
        prompt_id: promptId,
        retry_attempt: attempt,
        ...promptData
      },
      { status: "started" }
    );

    try {
      const response = await session.prompt(text, promptOptions);
      await recordPromptCompletion(options, promptId, startedAtMs, response);
      return response;
    } catch (error) {
      await recordPromptFailure(options, promptId, startedAtMs, error);
      const errorCode = classifyFluePromptError(error);
      const decision = retryDecision({
        policy: retryPolicy,
        attempt,
        errorCode
      });

      if (!decision.shouldRetry) {
        throw error;
      }

      await emitPromptRetryEvent(
        options,
        error,
        attempt,
        retryPolicy,
        errorCode,
        decision.delayMs
      );
      await sleep(decision.delayMs);
    }
  }

  throw codedError("Flue prompt retry exhausted", "flue_prompt_retry_exhausted");
}

export async function runFlueAgentStep(
  ctx: FlueContext<Invocation>,
  options: RunAgentStepOptions,
  mcpConfig?: McpConfig
): Promise<unknown> {
  const capabilityCwd = capabilityCwdFor(options);
  const instructions = await readFile(options.agent.instructionsPath, "utf8");
  const envelope = prepareAgentInstructionEnvelope({
    agent: {
      id: options.agent.id,
      mode: options.agent.mode,
      instructions
    },
    taskInput: options.input
  });
  const capabilities = await resolveFlueAgentCapabilities({
    agent: options.agent,
    cwd: capabilityCwd,
    agentsRoot: options.agentsRoot,
    modelProfiles: options.modelProfiles,
    workflowSubagentPolicy: options.workflowSubagentPolicy,
    context: contextIntakeFrom(options.input.context),
    mcpConfig,
    observability: options.observability,
    summary: options.summary,
    env: process.env
  });

  try {
    const agent = createAgent(async () => ({
      description: options.agent.description,
      instructions: envelope.instructions,
      skills: capabilities.skills,
      tools: capabilities.tools,
      subagents: capabilities.subagents,
      ...agentSandboxFor(options),
      ...toFlueModelOptions(options.model)
    }));
    const harness = await ctx.init(agent, { name: options.agent.id });
    const session = await harness.session();
    const promptId = `agent:${options.node.id}`;
    const response = await runPromptWithRetry({
      options,
      session,
      promptId,
      text: [options.agent.description, promptBody(envelope.taskInput)].join(
        "\n\n"
      ),
      promptOptions: {
        result: await resultSchema(options.agent.outputSchemaPath),
        ...toFluePromptOptions(options.model)
      },
      retryPolicy: readOnlyRetryPolicy(options)
    });

    return response.data;
  } finally {
    await capabilities.close();
  }
}

function writableAgentPrompt(
  options: RunAgentLoopStepOptions,
  input: RunWritableAgentInput,
  workflowInput: Record<string, unknown>
): string {
  return [
    options.agent.description,
    promptBody({
      phase: input.phase,
      attempt: input.attempt,
      workflow_input: workflowInput,
      ...(input.previousValidation === undefined
        ? {}
        : { previous_validation: input.previousValidation }),
      ...(input.previousError === undefined
        ? {}
        : { previous_error: input.previousError }),
      ...(input.diffSummary === undefined
        ? {}
        : { diff_summary: input.diffSummary })
    })
  ].join("\n\n");
}

async function runWritableAgent(
  ctx: FlueContext<Invocation>,
  options: RunAgentLoopStepOptions,
  input: RunWritableAgentInput,
  capabilities: ResolvedFlueAgentCapabilities,
  envelope: AgentInstructionEnvelope
): Promise<unknown> {
  const retryPolicy = writeModeRetryPolicy(options);
  const agent = createAgent(async () => ({
    description: options.agent.description,
    instructions: envelope.instructions,
    skills: capabilities.skills,
    tools: capabilities.tools,
    subagents: capabilities.subagents,
    cwd: options.sandbox.cwd,
    sandbox: local({
      cwd: options.sandbox.cwd,
      env: allowlistedEnv(options.sandbox.env_allowlist)
    }),
    ...toFlueModelOptions(options.model)
  }));
  const harness = await ctx.init(agent, { name: options.agent.id });
  const session = await harness.session();
  const promptId = `agent_loop:${options.node.id}:${input.phase}:${input.attempt}`;
  const response = await runPromptWithRetry({
    options,
    session,
    promptId,
    text: writableAgentPrompt(options, input, envelope.taskInput),
    retryPolicy,
    promptData: {
      phase: input.phase,
      attempt: input.attempt
    },
    promptOptions: {
      result: await resultSchema(options.agent.outputSchemaPath),
      ...toFluePromptOptions(options.model)
    }
  });

  return response.data;
}

export async function runFlueAgentLoopStep(
  ctx: FlueContext<Invocation>,
  options: RunAgentLoopStepOptions,
  mcpConfig?: McpConfig
): Promise<unknown> {
  if (options.sandbox.type !== "trusted_host_local") {
    throw codedError(
      `Unsupported agent_loop sandbox type: ${String(options.sandbox.type)}`,
      "agent_loop_sandbox_unsupported"
    );
  }

  if (options.agent.mode !== "trusted_local_write") {
    throw codedError(
      `Agent ${options.agent.id} must declare trusted_local_write for trusted_host_local execution`,
      "trusted_host_local_agent_mode_required"
    );
  }

  const instructions = await readFile(options.agent.instructionsPath, "utf8");
  const envelope = prepareAgentInstructionEnvelope({
    agent: {
      id: options.agent.id,
      mode: "trusted_local_write",
      instructions
    },
    taskInput: options.input
  });
  const capabilities = await resolveFlueAgentCapabilities({
    agent: options.agent,
    cwd: options.sandbox.cwd,
    agentsRoot: options.agentsRoot,
    modelProfiles: options.modelProfiles,
    workflowSubagentPolicy: options.workflowSubagentPolicy,
    context: contextIntakeFrom(options.input.context),
    mcpConfig,
    observability: options.observability,
    summary: options.summary,
    env: process.env
  });

  try {
    return await runAgentLoopStateMachine({
      cwd: options.sandbox.cwd,
      prompt: options.input,
      repairAttempts: options.repair.attempts,
      dependencies: {
        runWritableAgent: async (input) =>
          await runWritableAgent(ctx, options, input, capabilities, envelope),
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

export function createFlueAgentRunner({
  ctx,
  mcpConfig
}: FlueAgentRunnerOptions): FlueAgentRunner {
  return {
    runAgentStep: async (options) =>
      await runFlueAgentStep(ctx, options, mcpConfig),
    runAgentLoopStep: async (options) =>
      await runFlueAgentLoopStep(ctx, options, mcpConfig)
  };
}
