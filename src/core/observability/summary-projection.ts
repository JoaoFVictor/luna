import type { LunaSpan, LunaTelemetryRecord } from "./tracing.js";

export type TraceSummaryProjection = {
  schema_version: 2;
  run_id: string;
  workflow_id: string;
  trace_id: string;
  spans: {
    total: number;
    failed: number;
    duration_ms: number;
  };
  prompt_operations: number;
  usage_missing_count: number;
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    total: number;
  };
  cost: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    total: number;
    unit: "provider_cost_unit";
  };
  failed_steps: Array<{
    step_id: string;
    code?: string;
    message: string;
  }>;
};

export function createSummaryProjection(
  records: readonly LunaTelemetryRecord[]
): TraceSummaryProjection {
  const ended = records
    .filter((record): record is Extract<LunaTelemetryRecord, { type: "span.ended" }> => record.type === "span.ended")
    .map((record) => record.span);
  const first = ended[0] ?? records.find((record): record is Extract<LunaTelemetryRecord, { type: "span.started" }> => record.type === "span.started")?.span;
  const summary: TraceSummaryProjection = {
    schema_version: 2,
    run_id: first?.run_id ?? "unknown",
    workflow_id: first?.workflow_id ?? "unknown",
    trace_id: first?.trace_id ?? "unknown",
    spans: {
      total: ended.length,
      failed: ended.filter((span) => span.status === "error").length,
      duration_ms: ended.reduce((total, span) => total + (span.duration_ms ?? 0), 0)
    },
    prompt_operations: 0,
    usage_missing_count: 0,
    tokens: {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      total: 0
    },
    cost: {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      total: 0,
      unit: "provider_cost_unit"
    },
    failed_steps: []
  };

  const spanById = new Map(ended.map((span) => [span.span_id, span]));
  const fallbackSpanIds = aggregateFallbackSpanIds(ended, spanById);
  const spansCoveredByFallback = descendantSpanIds(fallbackSpanIds, ended);

  for (const span of ended) {
    const rollup = usageRollup(span);
    const contributesUsage = fallbackSpanIds.has(span.span_id) ||
      (rollup === "include" && !spansCoveredByFallback.has(span.span_id));

    if (contributesUsage) {
      summary.prompt_operations += 1;
      if (span.usage === undefined) {
        summary.usage_missing_count += 1;
      }
    }

    if (contributesUsage && span.usage !== undefined) {
      summary.tokens.input += span.usage.input_tokens;
      summary.tokens.output += span.usage.output_tokens;
      summary.tokens.cache_read += span.usage.cache_read_tokens;
      summary.tokens.cache_write += span.usage.cache_write_tokens;
      summary.tokens.total += span.usage.total_tokens;

      if (span.usage.cost !== undefined) {
        summary.cost.input += span.usage.cost.input;
        summary.cost.output += span.usage.cost.output;
        summary.cost.cache_read += span.usage.cost.cache_read;
        summary.cost.cache_write += span.usage.cost.cache_write;
        summary.cost.total += span.usage.cost.total;
      }
    }

    if (span.status === "error") {
      summary.failed_steps.push({
        step_id: span.node_id ?? span.name,
        ...(span.error?.code === undefined ? {} : { code: span.error.code }),
        message: span.error?.message ?? "Span failed"
      });
    }
  }

  return summary;
}

function aggregateFallbackSpanIds(
  spans: readonly LunaSpan[],
  spanById: ReadonlyMap<string, LunaSpan>
): ReadonlySet<string> {
  const fallbackCandidates = new Set(
    spans
      .filter((span) => span.usage !== undefined && usageRollup(span) === "aggregate_fallback")
      .map((span) => span.span_id)
  );

  for (const span of spans) {
    if (span.usage === undefined || usageRollup(span) !== "include") {
      continue;
    }

    let parentId = span.parent_span_id;
    while (parentId !== undefined) {
      const parent = spanById.get(parentId);
      if (parent === undefined) {
        break;
      }
      if (usageRollup(parent) === "aggregate_fallback") {
        fallbackCandidates.delete(parent.span_id);
      }
      parentId = parent.parent_span_id;
    }
  }

  return fallbackCandidates;
}

function descendantSpanIds(
  ancestorIds: ReadonlySet<string>,
  spans: readonly LunaSpan[]
): ReadonlySet<string> {
  const descendants = new Set<string>();
  const spanById = new Map(spans.map((span) => [span.span_id, span]));

  for (const span of spans) {
    let parentId = span.parent_span_id;
    while (parentId !== undefined) {
      if (ancestorIds.has(parentId)) {
        descendants.add(span.span_id);
        break;
      }
      parentId = spanById.get(parentId)?.parent_span_id;
    }
  }

  return descendants;
}

function usageRollup(span: LunaSpan): "include" | "exclude" | "aggregate_fallback" {
  if (span.usage?.rollup !== undefined) {
    return span.usage.rollup;
  }

  if (span.kind === "llm") {
    return "include";
  }

  if (span.kind === "agent") {
    return "aggregate_fallback";
  }

  return "exclude";
}
