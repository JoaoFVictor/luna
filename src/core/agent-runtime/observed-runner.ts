import type {
  AgentRuntimePort,
  AgentRuntimeUsage,
  RunAgentInput,
  RunAgentOutput
} from "./contracts.js";
import {
  recordPromptOperation,
  recordPromptUsage,
  recordPromptUsageMissing,
  type LunaUsageRecord,
  type ObservabilitySummary
} from "../observability/summary.js";

export async function runObservedAgent({
  runtime,
  input,
  observabilitySummary,
  now = () => Date.now()
}: {
  readonly runtime: AgentRuntimePort;
  readonly input: RunAgentInput;
  readonly observabilitySummary?: ObservabilitySummary;
  readonly now?: () => number;
}): Promise<RunAgentOutput> {
  const startedAt = now();
  try {
    const result = await runtime.runAgent(input);
    recordAgentObservation({
      input,
      result,
      observabilitySummary,
      durationMs: Math.max(0, now() - startedAt)
    });

    return result;
  } catch (cause) {
    recordPromptOperation(observabilitySummary, {
      durationMs: Math.max(0, now() - startedAt)
    });
    recordPromptUsageMissing(observabilitySummary);
    throw cause;
  }
}

function recordAgentObservation({
  input,
  result,
  observabilitySummary,
  durationMs
}: {
  readonly input: RunAgentInput;
  readonly result: RunAgentOutput;
  readonly observabilitySummary?: ObservabilitySummary;
  readonly durationMs: number;
}): void {
  recordPromptOperation(observabilitySummary, { durationMs });

  const usage = usageRecordFromRuntimeResult({ input, result });
  if (usage === undefined) {
    recordPromptUsageMissing(observabilitySummary);
    return;
  }

  recordPromptUsage(observabilitySummary, usage);
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
