import type { ObservabilitySummary } from "../../core/observability/summary.js";

export type ExecutionSummaryJson = {
  prompt_operations: number;
  prompt_duration_ms: number;
  usage_missing_count: number;
  tokens: ObservabilitySummary["tokens"];
  cost: ObservabilitySummary["cost"];
  failed_steps: ObservabilitySummary["failed_steps"];
  rejected_capabilities: ObservabilitySummary["rejected_capabilities"];
};

function formatCost(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, "");
}

export function executionSummaryJson(
  summary: ObservabilitySummary | undefined
): ExecutionSummaryJson | undefined {
  if (summary === undefined) {
    return undefined;
  }

  return {
    prompt_operations: summary.prompt_operations,
    prompt_duration_ms: summary.prompt_duration_ms,
    usage_missing_count: summary.usage_missing_count,
    tokens: { ...summary.tokens },
    cost: { ...summary.cost },
    failed_steps: [...summary.failed_steps],
    rejected_capabilities: [...summary.rejected_capabilities]
  };
}

export function executionSummaryMarkdownLines(
  summary: ObservabilitySummary | undefined
): string[] {
  const execution = executionSummaryJson(summary);

  if (execution === undefined) {
    return [];
  }

  return [
    "",
    "## Execution Summary",
    "",
    `Prompt operations: ${execution.prompt_operations}`,
    `Prompt duration: ${execution.prompt_duration_ms}ms`,
    `Tokens: ${execution.tokens.total} total (${execution.tokens.input} input, ${execution.tokens.output} output, ${execution.tokens.cache_read} cache read, ${execution.tokens.cache_write} cache write)`,
    `Cost: ${formatCost(execution.cost.total)} ${execution.cost.unit}`,
    `Usage missing: ${execution.usage_missing_count}`,
    `Failed steps: ${execution.failed_steps.length}`,
    `Rejected capabilities: ${execution.rejected_capabilities.length}`
  ];
}
