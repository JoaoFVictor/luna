import type {
  AgentRuntimePort,
  AgentRuntimeUsage,
  RunAgentInput,
  RunAgentOutput
} from "./contracts.js";
import type { ObservabilityRecorder } from "../observability/tracing.js";
import {
  agentFailedEvent,
  agentStartedEvent,
  agentSucceededEvent,
  type LunaUsageRecord,
  type ObservedAgentEvent
} from "./observed-agent-events.js";

export async function runObservedAgent({
  runtime,
  input,
  observability,
  emitEvent,
  now = () => Date.now()
}: {
  readonly runtime: AgentRuntimePort;
  readonly input: RunAgentInput;
  readonly observability?: ObservabilityRecorder;
  readonly emitEvent?: (event: ObservedAgentEvent) => Promise<void> | void;
  readonly now?: () => number;
}): Promise<RunAgentOutput> {
  const runtimeId = runtime.describe().id;
  return await observabilitySpan(
    observability,
    {
      name: `agent.${input.agent_id}`,
      kind: "agent",
      nodeId: input.node_id,
      agentId: input.agent_id,
      attributes: {
        "luna.agent.mode": input.agent_mode,
        "luna.agent.runtime": runtimeId,
        "luna.model_profile": input.model_profile.model
      },
      metadata: {
        runtime_requirements: input.runtime_requirements,
        local_tool_ids: input.tools.tools
          .filter((tool) => tool.protocol === "local")
          .map((tool) => tool.id),
        mcp_tool_ids: input.tools.tools
          .filter((tool) => tool.protocol === "mcp")
          .map((tool) => tool.id)
      }
    },
    async (span) => {
      const startedAt = now();
      await emitEvent?.(agentStartedEvent({ input, runtimeId }));

      let result: RunAgentOutput;
      try {
        result = await runtime.runAgent(input);
      } catch (cause) {
        const durationMs = Math.max(0, now() - startedAt);
        await emitEvent?.(agentFailedEvent({ input, runtimeId, durationMs, cause }));
        throw cause;
      }

      const durationMs = Math.max(0, now() - startedAt);
      const usage = usageRecordFromRuntimeResult({ input, result });
      if (usage !== undefined) {
        span?.setUsage({
          input_tokens: usage.tokens.input,
          output_tokens: usage.tokens.output,
          cache_read_tokens: usage.tokens.cache_read,
          cache_write_tokens: usage.tokens.cache_write,
          total_tokens: usage.tokens.total,
          rollup: "aggregate_fallback",
          cost: {
            input: usage.cost.input,
            output: usage.cost.output,
            cache_read: usage.cost.cache_read,
            cache_write: usage.cost.cache_write,
            total: usage.cost.total,
            unit: "provider_cost_unit"
          }
        });
      }
      for (const [key, value] of Object.entries(result.runtime_metadata ?? {})) {
        span?.setMetadata(`runtime.${key}`, value);
      }
      const provider = usage?.provider;
      const model = usage?.model;
      if (provider !== undefined) {
        span?.setAttribute("gen_ai.system", provider);
      }
      if (model !== undefined) {
        span?.setAttribute("gen_ai.request.model", model);
      }
      await emitEvent?.(
        agentSucceededEvent({
          input,
          runtimeId,
          durationMs,
          usage,
          runtimeMetadata: result.runtime_metadata
        })
      );

      return result;
    }
  );
}

async function observabilitySpan<T>(
  observability: ObservabilityRecorder | undefined,
  input: Parameters<ObservabilityRecorder["withSpan"]>[0],
  run: (span: Parameters<Parameters<ObservabilityRecorder["withSpan"]>[1]>[0] | undefined) => Promise<T>
): Promise<T> {
  if (observability === undefined) {
    return await run(undefined);
  }

  return await observability.withSpan(input, async (span) => await run(span));
}

function usageRecordFromRuntimeResult({
  input,
  result
}: {
  readonly input: RunAgentInput;
  readonly result: RunAgentOutput;
}): LunaUsageRecord | undefined {
  if (result.usage === undefined) {
    return undefined;
  }

  const provider = stringFrom(result.runtime_metadata?.provider) ?? providerFromModelProfile(input);
  const model = stringFrom(result.runtime_metadata?.model) ?? modelFromModelProfile(input);

  return {
    prompt_id: `${input.run.run_id}:${input.node_id}:${input.agent_id}`,
    model_profile: input.model_profile.model,
    provider,
    model,
    tokens: {
      input: nonnegativeNumber(result.usage.input_tokens),
      output: nonnegativeNumber(result.usage.output_tokens),
      cache_read: nonnegativeNumber(result.usage.cache_read_tokens),
      cache_write: nonnegativeNumber(result.usage.cache_write_tokens),
      total: nonnegativeNumber(result.usage.total_tokens)
    },
    cost: costFromUsage(result.usage)
  };
}

function costFromUsage(usage: AgentRuntimeUsage): LunaUsageRecord["cost"] {
  const cost = usage.cost;

  return {
    input: nonnegativeNumber(cost?.input),
    output: nonnegativeNumber(cost?.output),
    cache_read: nonnegativeNumber(cost?.cache_read),
    cache_write: nonnegativeNumber(cost?.cache_write),
    total: nonnegativeNumber(cost?.total),
    unit: "provider_cost_unit"
  };
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function providerFromModelProfile(input: RunAgentInput): string {
  if (typeof input.model_profile.provider === "string") {
    return input.model_profile.provider;
  }

  return input.model_profile.model.includes("/")
    ? input.model_profile.model.split("/")[0] ?? "unknown"
    : "unknown";
}

function modelFromModelProfile(input: RunAgentInput): string {
  if (input.model_profile.model.includes("/")) {
    return input.model_profile.model.split("/").slice(1).join("/");
  }

  return input.model_profile.model;
}

function nonnegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}
