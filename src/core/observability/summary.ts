export type LunaTokenSummary = {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
};

export type LunaCostSummary = LunaTokenSummary & {
  unit: "provider_cost_unit";
};

export type LunaUsageRecord = {
  prompt_id: string;
  model_profile: string;
  provider: string;
  model: string;
  tokens: LunaTokenSummary;
  cost: LunaCostSummary;
};

export type ObservabilitySummary = {
  schema_version: 1;
  run_id: string;
  workflow_id: string;
  events_path: "events.jsonl";
  prompt_operations: number;
  prompt_duration_ms: number;
  usage_missing_count: number;
  tokens: LunaTokenSummary;
  cost: LunaCostSummary;
  failed_steps: Array<{
    step_id: string;
    code?: string;
    message: string;
  }>;
  rejected_capabilities: Array<{
    agent_id?: string;
    capability: string;
    id: string;
    reason: string;
  }>;
};

export type ObservabilitySummaryPublisher = {
  publish(input: {
    readonly node_id: string;
    readonly path: string;
    readonly format: "json";
    readonly value: unknown;
    readonly overwrite_policy: "replace";
  }): Promise<unknown>;
};

const emptyTokens = (): LunaTokenSummary => ({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  total: 0
});

const emptyCost = (): LunaCostSummary => ({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  total: 0,
  unit: "provider_cost_unit"
});

export function serializableObservabilitySummary(
  summary: ObservabilitySummary
): ObservabilitySummary {
  return {
    schema_version: summary.schema_version,
    run_id: summary.run_id,
    workflow_id: summary.workflow_id,
    events_path: summary.events_path,
    prompt_operations: summary.prompt_operations,
    prompt_duration_ms: summary.prompt_duration_ms,
    usage_missing_count: summary.usage_missing_count,
    tokens: { ...summary.tokens },
    cost: { ...summary.cost },
    failed_steps: summary.failed_steps.map((step) => ({ ...step })),
    rejected_capabilities: summary.rejected_capabilities.map((rejection) => ({
      ...rejection
    }))
  };
}

export function createObservabilitySummary({
  runId,
  workflowId
}: {
  runId: string;
  workflowId: string;
}): ObservabilitySummary {
  const summary: ObservabilitySummary = {
    schema_version: 1 as const,
    run_id: runId,
    workflow_id: workflowId,
    events_path: "events.jsonl" as const,
    prompt_operations: 0,
    prompt_duration_ms: 0,
    usage_missing_count: 0,
    tokens: emptyTokens(),
    cost: emptyCost(),
    failed_steps: [],
    rejected_capabilities: []
  };

  return summary;
}

export async function writeSummaryBestEffort(
  publisher: ObservabilitySummaryPublisher | undefined,
  summary: ObservabilitySummary | undefined
): Promise<boolean> {
  if (publisher === undefined || summary === undefined) {
    return false;
  }

  try {
    await publisher.publish({
      node_id: "observability",
      path: "observability-summary.json",
      format: "json",
      value: serializableObservabilitySummary(summary),
      overwrite_policy: "replace"
    });
    return true;
  } catch {
    return false;
  }
}

export function recordPromptOperation(
  summary: ObservabilitySummary | undefined,
  operation:
    | {
        durationMs?: number;
      }
    | undefined
): void {
  if (summary === undefined || operation === undefined) {
    return;
  }

  summary.prompt_operations += 1;

  if (operation.durationMs !== undefined) {
    summary.prompt_duration_ms += operation.durationMs;
  }
}

export function recordPromptUsage(
  summary: ObservabilitySummary | undefined,
  usage: LunaUsageRecord | undefined
): void {
  if (summary === undefined || usage === undefined) {
    return;
  }

  summary.tokens.input += usage.tokens.input;
  summary.tokens.output += usage.tokens.output;
  summary.tokens.cache_read += usage.tokens.cache_read;
  summary.tokens.cache_write += usage.tokens.cache_write;
  summary.tokens.total += usage.tokens.total;
  summary.cost.input += usage.cost.input;
  summary.cost.output += usage.cost.output;
  summary.cost.cache_read += usage.cost.cache_read;
  summary.cost.cache_write += usage.cost.cache_write;
  summary.cost.total += usage.cost.total;
  summary.cost.unit = usage.cost.unit;
}

export function recordPromptUsageMissing(
  summary: ObservabilitySummary | undefined
): void {
  if (summary === undefined) {
    return;
  }

  summary.usage_missing_count += 1;
}

export function recordFailedStep(
  summary: ObservabilitySummary | undefined,
  failedStep:
    | {
        stepId: string;
        code?: string;
        message: string;
      }
    | undefined
): void {
  if (summary === undefined || failedStep === undefined) {
    return;
  }

  summary.failed_steps.push({
    step_id: failedStep.stepId,
    ...(failedStep.code === undefined ? {} : { code: failedStep.code }),
    message: failedStep.message
  });
}

export function recordRejectedCapability(
  summary: ObservabilitySummary | undefined,
  rejection:
    | {
        agentId?: string;
        capability: string;
        id: string;
        reason: string;
      }
    | undefined
): void {
  if (summary === undefined || rejection === undefined) {
    return;
  }

  summary.rejected_capabilities.push({
    ...(rejection.agentId === undefined ? {} : { agent_id: rejection.agentId }),
    capability: rejection.capability,
    id: rejection.id,
    reason: rejection.reason
  });
}
