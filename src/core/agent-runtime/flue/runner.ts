import { readFile } from "node:fs/promises";
import {
  createAgent,
  defineTool,
  type FlueContext,
  type PromptModel,
  type PromptUsage,
  type ToolDefinition
} from "@flue/runtime";
import { local } from "@flue/runtime/node";
import * as v from "valibot";
import type { GenericSchema } from "valibot";
import {
  runGatedAgentLoopStateMachine,
  type GateResult,
  type RunGatedWorkerInput
} from "../../../capabilities/quality-gates/gated-agent-loop.js";
import {
  contextIntakeFrom,
  prepareAgentInstructionEnvelope
} from "../../../capabilities/agents/agent-definition.js";
import type {
  RunGatedAgentLoopStepOptions
} from "../../configured-workflow/runner.js";
import type { ModelProfile } from "../../config/schemas.js";
import {
  resolveFlueAgentCapabilities,
  type ResolvedFlueAgentCapabilities
} from "./capabilities.js";
import { repositoryConfigFromState } from "../../workflow/state.js";
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
import type { Invocation } from "../../router/invocation.js";
import type {
  RunAgentInput,
  RunAgentOutput
} from "../../agent-runtime/contracts.js";
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
import {
  feedbackFromValidation,
  gateResultFromAgentOutput
} from "../../../capabilities/quality-gates/gate-results.js";
import { resolveGateInput } from "./gate-input.js";
import { resolveFlueMcpTools } from "./mcp-capabilities.js";

type FlueGatedAgentLoopRunnerOptions = {
  ctx: FlueContext<Invocation>;
  mcpConfig?: McpConfig;
};

type AgentInstructionEnvelope = ReturnType<
  typeof prepareAgentInstructionEnvelope
>;

export type FlueGatedAgentLoopRunner = {
  runGatedAgentLoopStep(options: RunGatedAgentLoopStepOptions): Promise<unknown>;
};

function codedError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function promptBody(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  return JSON.stringify(output) ?? String(output);
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
  options: RunGatedAgentLoopStepOptions,
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
  options: RunGatedAgentLoopStepOptions,
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
  options: RunGatedAgentLoopStepOptions,
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

function writeModeRetryPolicy(options: RunGatedAgentLoopStepOptions): RetryPolicy {
  return writeModeFluePromptRetryPolicy(options.node.retry);
}

async function emitPromptRetryEvent(
  options: RunGatedAgentLoopStepOptions,
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

function flueToolName(id: string): string {
  return id.replaceAll(".", "_").replaceAll("-", "_");
}

function materializeLocalRuntimeTools(input: RunAgentInput): ToolDefinition[] {
  const cwd = input.cwd;

  return input.tools.tools
    .filter((tool) => tool.protocol === "local")
    .map((tool) => {
      if (tool.local === undefined) {
        throw codedError(
          `Resolved local tool has no local contract: ${tool.id}`,
          "flue_tool_materialization_failed"
        );
      }
      if (cwd === undefined) {
        throw codedError(
          `Resolved local tool requires cwd: ${tool.id}`,
          "flue_tool_materialization_failed"
        );
      }

      const execute = tool.local.createHandler({ cwd });
      return defineTool({
        name: flueToolName(tool.id),
        description: tool.local.description,
        parameters: tool.local.parameters as object,
        execute: async (toolInput) =>
          stringifyToolOutput(await execute(toolInput))
      });
    });
}

export async function runFlueAgentRuntimeInput(
  ctx: FlueContext<Invocation>,
  input: RunAgentInput,
  mcpConfig?: McpConfig
): Promise<RunAgentOutput> {
  const mcpTools =
    input.tools.mcp_policy === undefined
      ? undefined
      : await resolveFlueMcpTools({
          ids: input.tools.mcp_policy.servers.map((server) => server.id),
          agentMode: input.agent_mode,
          config: mcpConfig ?? { mcp_servers: [] },
          env: process.env
        });

  try {
    const agent = createAgent(async () => ({
      description: input.agent_id,
      instructions: input.instructions,
      tools: [
        ...materializeLocalRuntimeTools(input),
        ...(mcpTools?.tools ?? [])
      ],
      ...(input.cwd === undefined
        ? {}
        : { cwd: input.cwd, sandbox: local({ cwd: input.cwd, env: {} }) }),
      ...toFlueModelOptions(input.model_profile)
    }));
    const harness = await ctx.init(agent, { name: input.agent_id });
    const session = await harness.session();
    const response = await session.prompt(
      [input.agent_id, promptBody(input.input)].join("\n\n"),
      {
        result: schemaFromJson(input.output_schema),
        ...toFluePromptOptions(input.model_profile)
      }
    );

    const usage = usageFromFlueResponse({
      promptId: `agent:${input.node_id}`,
      modelProfile: input.model_profile.model,
      response
    });

    return {
      output: response.data,
      ...(usage === undefined ? {} : { usage })
    };
  } finally {
    await mcpTools?.close();
  }
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
  options: RunGatedAgentLoopStepOptions;
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

function writableAgentPrompt(
  options: RunGatedAgentLoopStepOptions,
  input: RunGatedWorkerInput,
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
      ...(input.previousGates === undefined
        ? {}
        : { previous_gates: input.previousGates }),
      ...(input.diffSummary === undefined
        ? {}
        : { diff_summary: input.diffSummary })
    })
  ].join("\n\n");
}

async function initializeWritableAgentSession(
  ctx: FlueContext<Invocation>,
  options: RunGatedAgentLoopStepOptions,
  capabilities: ResolvedFlueAgentCapabilities,
  envelope: AgentInstructionEnvelope
): Promise<PromptSession> {
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

  return await harness.session();
}

async function runWritableAgent(
  options: RunGatedAgentLoopStepOptions,
  input: RunGatedWorkerInput,
  envelope: AgentInstructionEnvelope,
  session: PromptSession
): Promise<unknown> {
  const retryPolicy = writeModeRetryPolicy(options);
  const promptId = `gated_agent_loop:${options.node.id}:${input.phase}:${input.attempt}`;
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

type GateAgentSessions = {
  sessions: Record<string, PromptSession>;
  close(): Promise<void>;
};

async function initializeGateAgentSessions(
  ctx: FlueContext<Invocation>,
  options: RunGatedAgentLoopStepOptions,
  mcpConfig: McpConfig | undefined
): Promise<GateAgentSessions> {
  const sessions: Record<string, PromptSession> = {};
  const capabilitiesToClose: ResolvedFlueAgentCapabilities[] = [];

  for (const gate of options.gates) {
    if (gate.type !== "agent") {
      continue;
    }

    const gateAgent = options.gateAgents[gate.id];
    if (gateAgent === undefined) {
      throw codedError(
        `Gated agent loop gate agent is missing: ${gate.id}`,
        "gated_agent_loop_gate_agent_missing"
      );
    }

    const instructions = await readFile(gateAgent.instructionsPath, "utf8");
    const envelope = prepareAgentInstructionEnvelope({
      agent: {
        id: gateAgent.id,
        mode: gateAgent.mode,
        instructions
      },
      taskInput: {
        workflow_input: options.input,
        gate_input: gate.input ?? {}
      }
    });
    const capabilities = await resolveFlueAgentCapabilities({
      agent: gateAgent,
      cwd: options.sandbox.cwd,
      agentsRoot: options.agentsRoot,
      modelProfiles: options.modelProfiles,
      workflowSubagentPolicy: options.workflowSubagentPolicy,
      context: contextIntakeFrom(options.input.context),
      mcpConfig,
      observability: options.observability,
      summary: options.summary,
      repository: repositoryConfigFromState(options.state),
      env: process.env
    });
    capabilitiesToClose.push(capabilities);

    const agent = createAgent(async () => ({
      description: gateAgent.description,
      instructions: envelope.instructions,
      skills: capabilities.skills,
      tools: capabilities.tools,
      subagents: capabilities.subagents,
      cwd: options.sandbox.cwd,
      sandbox: local({ cwd: options.sandbox.cwd, env: {} }),
      ...toFlueModelOptions(resolveGateModel(gateAgent, options))
    }));
    const harness = await ctx.init(agent, {
      name: `${options.node.id}-${gate.id}`
    });
    sessions[gate.id] = await harness.session();
  }

  return {
    sessions,
    close: async () => {
      await Promise.all(
        capabilitiesToClose.map(async (capabilities) => await capabilities.close())
      );
    }
  };
}

function resolveGateModel(
  gateAgent: RunGatedAgentLoopStepOptions["agent"],
  options: RunGatedAgentLoopStepOptions
): ModelProfile {
  const profile = options.modelProfiles[gateAgent.model_profile];

  if (profile === undefined) {
    throw codedError(
      `Model profile not found for gate agent ${gateAgent.id}: ${gateAgent.model_profile}`,
      "model_profile_missing"
    );
  }

  return profile;
}

async function runAgentGate({
  options,
  gate,
  session,
  workerOutput,
  validation,
  diffSummary,
  gateOutputs,
  attempt
}: {
  options: RunGatedAgentLoopStepOptions;
  gate: Extract<RunGatedAgentLoopStepOptions["gates"][number], { type: "agent" }>;
  session: PromptSession;
  workerOutput: unknown;
  validation: unknown;
  diffSummary: unknown;
  gateOutputs: Record<string, unknown>;
  attempt: number;
}): Promise<GateResult> {
  const gateAgent = options.gateAgents[gate.id];
  if (gateAgent === undefined) {
    throw codedError(
      `Gated agent loop gate agent is missing: ${gate.id}`,
      "gated_agent_loop_gate_agent_missing"
    );
  }

  const promptId = `gated_agent_loop:${options.node.id}:gate:${gate.id}:${attempt}`;
  const gateInput = await resolveGateInput(gate.input, {
    gate: {
      output: workerOutput,
      validation,
      diff_summary: diffSummary,
      outputs: gateOutputs,
      attempt
    }
  });
  const response = await runPromptWithRetry({
    options,
    session,
    promptId,
    text: [
      gateAgent.description,
      promptBody({
        workflow_input: options.input,
        gate_input: gateInput,
        worker_output: workerOutput,
        validation,
        diff_summary: diffSummary,
        gate_outputs: gateOutputs
      })
    ].join("\n\n"),
    retryPolicy: readOnlyFluePromptRetryPolicy(undefined),
    promptData: { gate_id: gate.id, attempt },
    promptOptions: {
      result: await resultSchema(gateAgent.outputSchemaPath),
      ...toFluePromptOptions(resolveGateModel(gateAgent, options))
    }
  });

  return await gateResultFromAgentOutput({
    id: gate.id,
    type: gate.type,
    blockWhen: normalizeGateExpression(gate.block_when),
    feedback:
      gate.feedback === undefined
        ? undefined
        : normalizeGateExpression(gate.feedback),
    output: { gate: response.data }
  });
}

function normalizeGateExpression(
  value: string | { expression: string }
): { expression: string } {
  return typeof value === "string" ? { expression: value } : value;
}

export async function runFlueGatedAgentLoopStep(
  ctx: FlueContext<Invocation>,
  options: RunGatedAgentLoopStepOptions,
  mcpConfig?: McpConfig
): Promise<unknown> {
  if (options.sandbox.type !== "trusted_host_local") {
    throw codedError(
      `Unsupported gated_agent_loop sandbox type: ${String(options.sandbox.type)}`,
      "gated_agent_loop_sandbox_unsupported"
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
    repository: repositoryConfigFromState(options.state),
    env: process.env
  });

  try {
    const session = await initializeWritableAgentSession(
      ctx,
      options,
      capabilities,
      envelope
    );
    const gateAgentSessions = await initializeGateAgentSessions(
      ctx,
      options,
      mcpConfig
    );

    try {
      return await runGatedAgentLoopStateMachine({
        cwd: options.sandbox.cwd,
        prompt: options.input,
        repairAttempts: options.repair.attempts,
        dependencies: {
          runWorker: async (input) =>
            await runWritableAgent(options, input, envelope, session),
          runValidation: async () => {
            const validationGate = options.gates.find(
              (gate) => gate.type === "validation_commands"
            );

            if (validationGate === undefined) {
              return { passed: true, commands: [] };
            }

            return await runValidationCommands({
              cwd: options.sandbox.cwd,
              commands: validationGate.commands,
              maxOutputBytes: validationGate.max_output_bytes
            });
          },
          collectDiffSummary: async () =>
            await collectWorktreeDiff({
              cwd: options.sandbox.cwd,
              maxDiffBytes:
                options.gates.find((gate) => gate.type === "validation_commands")
                  ?.max_output_bytes ?? 200000
            }),
          runGates: async ({ workerOutput, validation, diffSummary, attempt }) => {
            const results: GateResult[] = [];
            const outputs: Record<string, unknown> = {};

            for (const gate of options.gates) {
              if (gate.type === "validation_commands") {
                const result: GateResult = {
                  id: gate.id,
                  type: gate.type,
                  passed: validation.passed,
                  ...(validation.passed
                    ? {}
                    : { feedback: feedbackFromValidation(validation.commands) }),
                  output: validation
                };
                results.push(result);
                outputs[gate.id] = validation;
                continue;
              }

              const sessionForGate = gateAgentSessions.sessions[gate.id];
              if (sessionForGate === undefined) {
                throw codedError(
                  `Gated agent loop gate session is missing: ${gate.id}`,
                  "gated_agent_loop_gate_session_missing"
                );
              }

              const result = await runAgentGate({
                options,
                gate,
                session: sessionForGate,
                workerOutput,
                validation,
                diffSummary,
                gateOutputs: outputs,
                attempt
              });
              results.push(result);
              outputs[gate.id] = result.output;
            }

            return {
              passed: results.every((result) => result.passed),
              results,
              outputs
            };
          }
        }
      });
    } finally {
      await gateAgentSessions.close();
    }
  } finally {
    await capabilities.close();
  }
}

export function createFlueGatedAgentLoopRunner({
  ctx,
  mcpConfig
}: FlueGatedAgentLoopRunnerOptions): FlueGatedAgentLoopRunner {
  return {
    runGatedAgentLoopStep: async (options) =>
      await runFlueGatedAgentLoopStep(ctx, options, mcpConfig)
  };
}
