import type { LunaUsageRecord } from "../../core/observability/summary.js";

type PiUsageResponse = {
  readonly promptId: string;
  readonly modelProfile: string;
  readonly response: {
    readonly usage?: {
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
      readonly totalTokens: number;
      readonly cost: {
        readonly input: number;
        readonly output: number;
        readonly cacheRead: number;
        readonly cacheWrite: number;
        readonly total: number;
      };
    };
    readonly model?: {
      readonly provider: string;
      readonly id: string;
    };
  };
};

export function usageFromPiResponse({
  promptId,
  modelProfile,
  response
}: PiUsageResponse): LunaUsageRecord | undefined {
  if (response.usage === undefined || response.model === undefined) {
    return undefined;
  }

  return {
    prompt_id: promptId,
    model_profile: modelProfile,
    provider: response.model.provider,
    model: response.model.id,
    tokens: {
      input: response.usage.input,
      output: response.usage.output,
      cache_read: response.usage.cacheRead,
      cache_write: response.usage.cacheWrite,
      total: response.usage.totalTokens
    },
    cost: {
      input: response.usage.cost.input,
      output: response.usage.cost.output,
      cache_read: response.usage.cost.cacheRead,
      cache_write: response.usage.cost.cacheWrite,
      total: response.usage.cost.total,
      unit: "provider_cost_unit"
    }
  };
}
