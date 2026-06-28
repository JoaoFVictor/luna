import type { TraceSummaryProjection } from "../../core/observability/tracing.js";

export type ExecutionSummaryJson = {
  prompt_operations: number;
  usage_missing_count: number;
  tokens: TraceSummaryProjection["tokens"];
  cost: TraceSummaryProjection["cost"];
  failed_steps: TraceSummaryProjection["failed_steps"];
  spans?: TraceSummaryProjection["spans"];
  trace_id?: string;
};

function formatCost(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, "");
}

export function executionSummaryJson(
  summary: TraceSummaryProjection | undefined
): ExecutionSummaryJson | undefined {
  if (summary === undefined) {
    return undefined;
  }

  return {
    prompt_operations: summary.prompt_operations,
    usage_missing_count: summary.usage_missing_count,
    tokens: { ...summary.tokens },
    cost: { ...summary.cost },
    failed_steps: [...summary.failed_steps],
    spans: { ...summary.spans },
    trace_id: summary.trace_id
  };
}

export function executionSummaryMarkdownLines(
  summary: TraceSummaryProjection | undefined
): string[] {
  const execution = executionSummaryJson(summary);

  if (execution === undefined) {
    return [];
  }

  return [
    "",
    "## Execution Summary",
    "",
    ...(execution.trace_id === undefined ? [] : [`Trace: ${execution.trace_id}`]),
    `Prompt operations: ${execution.prompt_operations}`,
    `Tokens: ${execution.tokens.total} total (${execution.tokens.input} input, ${execution.tokens.output} output, ${execution.tokens.cache_read} cache read, ${execution.tokens.cache_write} cache write)`,
    `Cost: ${formatCost(execution.cost.total)} ${execution.cost.unit}`,
    `Usage missing: ${execution.usage_missing_count}`,
    `Failed steps: ${execution.failed_steps.length}`,
    ...(execution.spans === undefined
      ? []
      : [
          `Spans: ${execution.spans.total} total, ${execution.spans.failed} failed, ${execution.spans.duration_ms}ms observed`
        ])
  ];
}
