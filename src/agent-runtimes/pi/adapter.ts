import { createHash } from "node:crypto";
import {
  complete as defaultComplete,
  getModel as defaultGetModel,
  type AssistantMessage,
  type Context,
  type Model,
  type Tool
} from "@earendil-works/pi-ai/compat";
import {
  AgentRuntimeError,
  normalizeAgentRuntimeError,
  type AgentRuntimeDescriptor,
  type AgentRuntimePort,
  type RunAgentInput,
  type RunAgentOutput
} from "../../core/agent-runtime/contracts.js";
import type { LunaUsage } from "../../core/observability/tracing.js";
import { validateAgentRuntimeInput } from "../../core/agent-runtime/validation.js";
import { matchesJsonSchema } from "../../core/capabilities/json-schema.js";
import type { ModelProfile } from "../../core/config/schemas.js";
import { registeredPiProviderApiKey } from "./auth.js";

type CompleteFn = (
  model: Model<string>,
  context: Context,
  options?: Record<string, unknown>
) => Promise<AssistantMessage>;

type GetModelFn = (provider: string, model: string) => Model<string>;

export type PiAgentRuntimeOptions = {
  readonly complete?: CompleteFn;
  readonly getModel?: GetModelFn;
  readonly maxToolIterations?: number;
  readonly requestTimeoutMs?: number;
};

const PI_DESCRIPTOR: AgentRuntimeDescriptor = {
  id: "pi",
  display_name: "Pi AI",
  supported_tool_protocols: ["local"],
  supported_runtime_requirements: ["tool_calling"]
};

const DEFAULT_MAX_TOOL_ITERATIONS = 8;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const PI_SESSION_ID_PREFIX = "luna-";

function piRuntimeError(
  code: AgentRuntimeError["code"],
  message: string,
  details?: Record<string, unknown>
): AgentRuntimeError {
  return new AgentRuntimeError(code, message, details === undefined ? {} : { details });
}

function toolNameFor(id: string): string {
  return id.replaceAll(".", "_").replaceAll("-", "_");
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function textFrom(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function extractJsonText(text: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim());
  return fenced?.[1]?.trim() ?? text.trim();
}

function parseOutput(message: AssistantMessage): unknown {
  const text = extractJsonText(textFrom(message));
  if (text === "") {
    throw piRuntimeError(
      "runtime_output_schema_invalid",
      "Pi runtime returned no JSON output"
    );
  }

  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new AgentRuntimeError(
      "runtime_output_schema_invalid",
      "Pi runtime output was not valid JSON",
      { cause }
    );
  }
}

function modelSelection(profile: ModelProfile): {
  readonly provider: string;
  readonly model: string;
} {
  if (profile.provider !== undefined) {
    return { provider: profile.provider, model: profile.model };
  }

  const separator = profile.model.indexOf("/");
  if (separator <= 0 || separator === profile.model.length - 1) {
    throw piRuntimeError(
      "runtime_unsupported_feature",
      "Pi model profiles require provider/model or an explicit provider field",
      { model: profile.model }
    );
  }

  return {
    provider: profile.model.slice(0, separator),
    model: profile.model.slice(separator + 1)
  };
}

function runOptions(
  input: RunAgentInput,
  provider: string,
  signal: AbortSignal | undefined
): Record<string, unknown> {
  const apiKey = registeredPiProviderApiKey(provider);

  return {
    signal,
    reasoning: input.model_profile.reasoning_effort,
    transport: input.model_profile.transport,
    sessionId: piSessionId(input),
    ...(apiKey === undefined ? {} : { apiKey })
  };
}

async function withTimeout<T>(
  operation: (signal: AbortSignal | undefined) => Promise<T>,
  inputSignal: AbortSignal | undefined,
  timeoutMs: number
): Promise<T> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => {
    timeoutController.abort();
  }, timeoutMs);
  const abortFromInput = () => timeoutController.abort();

  inputSignal?.addEventListener("abort", abortFromInput, { once: true });
  if (inputSignal?.aborted === true) {
    timeoutController.abort();
  }
  try {
    return await Promise.race([
      operation(timeoutController.signal),
      new Promise<T>((_resolve, reject) => {
        timeoutController.signal.addEventListener(
          "abort",
          () => {
            reject(
              inputSignal?.aborted === true
                ? new DOMException("Pi runtime request was cancelled", "AbortError")
                : piRuntimeError(
                    "runtime_provider_unavailable",
                    `Pi runtime request timed out after ${timeoutMs}ms`,
                    { timeout_ms: timeoutMs }
                  )
            );
          },
          { once: true }
        );
      })
    ]);
  } finally {
    clearTimeout(timeout);
    inputSignal?.removeEventListener("abort", abortFromInput);
  }
}

function piSessionId(input: RunAgentInput): string {
  const hash = createHash("sha256")
    .update(input.run.run_id)
    .update(":")
    .update(input.node_id)
    .digest("hex")
    .slice(0, 48);

  return `${PI_SESSION_ID_PREFIX}${hash}`;
}

function systemPrompt(input: RunAgentInput): string {
  return [
    input.instructions,
    "",
    "Return only JSON that matches the requested output schema.",
    "Do not wrap the final answer in prose."
  ].join("\n");
}

function userPrompt(input: RunAgentInput): string {
  return JSON.stringify(
    {
      agent_id: input.agent_id,
      node_id: input.node_id,
      mode: input.agent_mode,
      input: input.input,
      context: input.context,
      output_schema: input.output_schema
    },
    null,
    2
  );
}

function piTools(input: RunAgentInput): {
  readonly tools: Tool[];
  readonly handlers: ReadonlyMap<string, (args: unknown) => Promise<unknown>>;
  readonly originalToolIds: ReadonlyMap<string, string>;
} {
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  const originalToolIds = new Map<string, string>();
  const tools = input.tools.tools
    .filter((tool) => tool.protocol === "local")
    .map((tool): Tool => {
      const name = toolNameFor(tool.id);
      if (tool.local === undefined) {
        throw piRuntimeError(
          "runtime_tool_materialization_failed",
          `Local tool ${tool.id} has no materialized handler`
        );
      }
      if (input.cwd === undefined) {
        throw piRuntimeError(
          "runtime_tool_materialization_failed",
          `Local tool ${tool.id} requires a cwd`
        );
      }

      const handler = tool.local.createHandler({ cwd: input.cwd });
      originalToolIds.set(name, tool.id);
      handlers.set(name, async (args) => {
        if (!matchesJsonSchema(tool.input_schema, args)) {
          throw piRuntimeError(
            "runtime_tool_materialization_failed",
            `Tool ${tool.id} arguments did not match input schema`,
            { tool_id: tool.id }
          );
        }

        return await handler(args);
      });

      return {
        name,
        description: tool.local.description,
        parameters: tool.input_schema as Tool["parameters"]
      };
    });

  return { tools, handlers, originalToolIds };
}

function toolCalls(message: AssistantMessage): {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}[] {
  return message.content
    .filter((block) => block.type === "toolCall")
    .map((block) => ({
      id: block.id,
      name: block.name,
      arguments: block.arguments
    }));
}

async function appendToolResults(
  context: Context,
  calls: ReturnType<typeof toolCalls>,
  handlers: ReadonlyMap<string, (args: unknown) => Promise<unknown>>,
  originalToolIds: ReadonlyMap<string, string>,
  observability: RunAgentInput["observability"]
): Promise<void> {
  for (const call of calls) {
    const handler = handlers.get(call.name);
    if (handler === undefined) {
      context.messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: `Unknown tool: ${call.name}` }],
        isError: true,
        timestamp: Date.now()
      });
      continue;
    }

    try {
      const runTool = async () => await handler(call.arguments);
      const output = observability === undefined
        ? await runTool()
        : await observability.withSpan(
            {
              name: `tool.${originalToolIds.get(call.name) ?? call.name}`,
              kind: "tool",
              attributes: {
                "tool.name": call.name,
                "tool.call_id": call.id
              },
              metadata: {
                tool_call_id: call.id,
                tool_name: call.name,
                tool_id: originalToolIds.get(call.name),
                arguments: call.arguments
              }
            },
            runTool
          );
      context.messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: stringify(output) }],
        isError: false,
        timestamp: Date.now()
      });
    } catch (cause) {
      context.messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [
          {
            type: "text",
            text: cause instanceof Error ? cause.message : "Tool execution failed"
          }
        ],
        isError: true,
        timestamp: Date.now()
      });
    }
  }
}

function usageFrom(message: AssistantMessage): RunAgentOutput["usage"] {
  return {
    input_tokens: message.usage.input,
    output_tokens: message.usage.output,
    total_tokens: message.usage.totalTokens,
    cache_read_tokens: message.usage.cacheRead,
    cache_write_tokens: message.usage.cacheWrite,
    cost: {
      input: message.usage.cost.input,
      output: message.usage.cost.output,
      cache_read: message.usage.cost.cacheRead,
      cache_write: message.usage.cost.cacheWrite,
      total: message.usage.cost.total,
      unit: "provider_cost_unit"
    }
  };
}

function lunaUsageFrom(message: AssistantMessage): LunaUsage {
  return {
    input_tokens: message.usage.input,
    output_tokens: message.usage.output,
    total_tokens: message.usage.totalTokens,
    cache_read_tokens: message.usage.cacheRead,
    cache_write_tokens: message.usage.cacheWrite,
    cost: {
      input: message.usage.cost.input,
      output: message.usage.cost.output,
      cache_read: message.usage.cost.cacheRead,
      cache_write: message.usage.cost.cacheWrite,
      total: message.usage.cost.total,
      unit: "provider_cost_unit"
    }
  };
}

function normalizePiError(cause: unknown): AgentRuntimeError {
  if (cause instanceof AgentRuntimeError) {
    return cause;
  }
  if ((cause as { name?: unknown }).name === "AbortError") {
    return new AgentRuntimeError("runtime_cancelled", "Pi runtime request was cancelled", {
      cause
    });
  }

  return normalizeAgentRuntimeError(cause);
}

export function createPiAgentRuntimeAdapter(
  options: PiAgentRuntimeOptions = {}
): AgentRuntimePort {
  const complete = options.complete ?? (defaultComplete as CompleteFn);
  const getModel = options.getModel ?? (defaultGetModel as GetModelFn);
  const maxToolIterations = options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw piRuntimeError(
      "runtime_unsupported_feature",
      "Pi requestTimeoutMs must be a positive integer",
      { requestTimeoutMs }
    );
  }

  return {
    describe(): AgentRuntimeDescriptor {
      return PI_DESCRIPTOR;
    },
    async validate(input: RunAgentInput): Promise<void> {
      await validateAgentRuntimeInput(input, PI_DESCRIPTOR);
      piTools(input);
      modelSelection(input.model_profile);
    },
    async runAgent(input: RunAgentInput): Promise<RunAgentOutput> {
      await validateAgentRuntimeInput(input, PI_DESCRIPTOR);

      try {
        const selected = modelSelection(input.model_profile);
        const model = getModel(selected.provider, selected.model);
        const materialized = piTools(input);
        const context: Context = {
          systemPrompt: systemPrompt(input),
          messages: [
            {
              role: "user",
              content: userPrompt(input),
              timestamp: Date.now()
            }
          ],
          ...(materialized.tools.length === 0 ? {} : { tools: materialized.tools })
        };

        for (let iteration = 0; iteration <= maxToolIterations; iteration += 1) {
          const completeOnce = async () =>
            await withTimeout(
              async (signal) =>
                await complete(model, context, runOptions(input, selected.provider, signal)),
              input.signal,
              requestTimeoutMs
            );
          const message = input.observability === undefined
            ? await completeOnce()
            : await input.observability.withSpan(
                {
                  name: "llm.complete",
                  kind: "llm",
                  provider: selected.provider,
                  model: selected.model,
                  attributes: {
                    "gen_ai.system": selected.provider,
                    "gen_ai.request.model": selected.model,
                    "luna.pi.iteration": iteration
                  },
                  metadata: {
                    session_id: piSessionId(input),
                    max_tool_iterations: maxToolIterations
                  }
                },
                async (span) => {
                  const message = await completeOnce();
                  span.setUsage(lunaUsageFrom(message));
                  span.setMetadata("response_id", message.responseId);
                  span.setMetadata("stop_reason", message.stopReason);
                  span.setMetadata("provider", message.provider);
                  span.setMetadata("model", message.model);
                  return message;
                }
              );
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            throw piRuntimeError(
              message.stopReason === "aborted"
                ? "runtime_cancelled"
                : "runtime_provider_unavailable",
              message.errorMessage ?? "Pi runtime request failed"
            );
          }

          context.messages.push(message);
          const calls = toolCalls(message);
          if (calls.length === 0) {
            return {
              output: parseOutput(message),
              usage: usageFrom(message),
              runtime_metadata: {
                provider: message.provider,
                model: message.model,
                response_id: message.responseId,
                stop_reason: message.stopReason
              }
            };
          }

          await appendToolResults(
            context,
            calls,
            materialized.handlers,
            materialized.originalToolIds,
            input.observability
          );
        }

        throw piRuntimeError(
          "runtime_unknown_failure",
          "Pi runtime exceeded the configured tool iteration limit",
          { max_tool_iterations: maxToolIterations }
        );
      } catch (cause) {
        throw normalizePiError(cause);
      }
    }
  };
}

export function piRuntimeDescriptor(): AgentRuntimeDescriptor {
  return PI_DESCRIPTOR;
}
