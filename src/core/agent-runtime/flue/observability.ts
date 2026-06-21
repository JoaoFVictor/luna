import type { PromptModel, PromptUsage } from "@flue/runtime";
import type { LunaEvent, LunaObservabilitySink } from "../../observability/events.js";
import { sanitizeAttributes } from "../../observability/sanitize.js";
import type {
  LunaCostSummary,
  LunaTokenSummary,
  LunaUsageRecord
} from "../../observability/summary.js";

type FlueLogAttributes = Record<string, unknown>;

type FlueLog = {
  info(message: string, attributes?: FlueLogAttributes): void;
  warn(message: string, attributes?: FlueLogAttributes): void;
  error(message: string, attributes?: FlueLogAttributes): void;
};

type FluePromptResponseWithUsage = {
  usage?: PromptUsage;
  model?: PromptModel;
};

function errorAttributes(event: LunaEvent): FlueLogAttributes {
  const error =
    event.data?.error !== null && typeof event.data?.error === "object"
      ? (event.data.error as Record<string, unknown>)
      : undefined;

  return {
    ...(error?.code === undefined ? {} : { "error.code": error.code }),
    ...(error?.message === undefined ? {} : { "error.message": error.message })
  };
}

function attributesForEvent(event: LunaEvent): FlueLogAttributes {
  const attributes = sanitizeAttributes(event.data);
  const filteredAttributes = Object.fromEntries(
    Object.entries(attributes).filter(
      ([key]) => !key.startsWith("luna.") && !key.startsWith("error.")
    )
  );

  return {
    ...filteredAttributes,
    "luna.timestamp": event.timestamp,
    "luna.run_id": event.run.id,
    ...(event.run.runtimeRunId === undefined
      ? {}
      : { "luna.flue_run_id": event.run.runtimeRunId }),
    "luna.run_attempt": event.run.attempt,
    "luna.workflow_id": event.workflow.id,
    ...(event.step === undefined
      ? {}
      : {
          "luna.step_id": event.step.id,
          "luna.step_type": event.step.type
        }),
    ...(event.outcome === undefined
      ? {}
      : {
          "luna.outcome_status": event.outcome.status,
          ...(event.outcome.code === undefined
            ? {}
            : { "luna.outcome_code": event.outcome.code })
        }),
    ...errorAttributes(event)
  };
}

export function createFlueLogSink(log: FlueLog): LunaObservabilitySink {
  return {
    id: "flue-log",
    required: false,
    append: async (event) => {
      log[event.severity](event.type, attributesForEvent(event));
    }
  };
}

function tokensFromFlueUsage(usage: PromptUsage): LunaTokenSummary {
  return {
    input: usage.input,
    output: usage.output,
    cache_read: usage.cacheRead,
    cache_write: usage.cacheWrite,
    total: usage.totalTokens
  };
}

function costFromFlueUsage(usage: PromptUsage): LunaCostSummary {
  return {
    input: usage.cost.input,
    output: usage.cost.output,
    cache_read: usage.cost.cacheRead,
    cache_write: usage.cost.cacheWrite,
    total: usage.cost.total,
    unit: "provider_cost_unit"
  };
}

export function usageFromFlueResponse({
  promptId,
  modelProfile,
  response
}: {
  promptId: string;
  modelProfile: string;
  response: FluePromptResponseWithUsage | undefined;
}): LunaUsageRecord | undefined {
  const usage = response?.usage;
  const model = response?.model;

  if (usage === undefined || model === undefined) {
    return undefined;
  }

  return {
    prompt_id: promptId,
    model_profile: modelProfile,
    provider: model.provider,
    model: model.id,
    tokens: tokensFromFlueUsage(usage),
    cost: costFromFlueUsage(usage)
  };
}
