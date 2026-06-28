import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sanitizeJsonObject } from "./sanitize.js";
import type { JsonObject } from "../runtime/json.js";

export {
  createSummaryProjection,
  type TraceSummaryProjection
} from "./summary-projection.js";

export type LunaSpanKind =
  | "workflow"
  | "node"
  | "built_in"
  | "agent"
  | "llm"
  | "tool"
  | "gate"
  | "lock"
  | "artifact"
  | "interrupt"
  | "runtime";

export type LunaSpanStatus = "ok" | "error" | "cancelled" | "waiting" | "skipped";

export type LunaSpanAttributes = Record<string, string | number | boolean>;

export type LunaUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  rollup?: "include" | "exclude" | "aggregate_fallback";
  cost?: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    total: number;
    unit: "provider_cost_unit";
  };
};

export type LunaSpanError = {
  code?: string;
  message: string;
  type?: string;
  details?: JsonObject;
};

export type LunaSpan = {
  schema_version: 1;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  run_id: string;
  workflow_id: string;
  attempt: number;
  name: string;
  kind: LunaSpanKind;
  status: LunaSpanStatus;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  node_id?: string;
  capability_id?: string;
  agent_id?: string;
  provider?: string;
  model?: string;
  attributes: LunaSpanAttributes;
  metadata: JsonObject;
  usage?: LunaUsage;
  error?: LunaSpanError;
};

export type LunaSpanEvent = {
  name: string;
  timestamp: string;
  attributes: JsonObject;
};

export type LunaMetric = {
  name: string;
  timestamp: string;
  value: number;
  unit?: string;
  attributes: LunaSpanAttributes;
};

export type LunaDiagnosticLog = {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  trace_id?: string;
  span_id?: string;
  node_id?: string;
  attributes: JsonObject;
};

export type LunaTelemetryRecord =
  | {
      type: "span.started";
      span: LunaSpan;
    }
  | {
      type: "span.ended";
      span: LunaSpan;
    }
  | {
      type: "span.event";
      trace_id: string;
      span_id: string;
      event: LunaSpanEvent;
    }
  | {
      type: "metric";
      metric: LunaMetric;
    }
  | {
      type: "log";
      log: LunaDiagnosticLog;
    };

export type ObservabilitySink = {
  id: string;
  required: boolean;
  emit(record: LunaTelemetryRecord): Promise<void> | void;
  flush?(): Promise<void>;
};

export type StartSpanInput = {
  name: string;
  kind: LunaSpanKind;
  status?: LunaSpanStatus;
  nodeId?: string;
  capabilityId?: string;
  agentId?: string;
  provider?: string;
  model?: string;
  attributes?: LunaSpanAttributes;
  metadata?: Record<string, unknown>;
};

export type ActiveSpan = {
  readonly span: LunaSpan;
  addEvent(name: string, attributes?: Record<string, unknown>): Promise<void>;
  setAttribute(key: string, value: string | number | boolean): void;
  setMetadata(key: string, value: unknown): void;
  setUsage(usage: LunaUsage): void;
  setStatus(status: LunaSpanStatus): void;
};

export type ObservabilityRecorder = {
  startSpan(input: StartSpanInput): Promise<ActiveSpan>;
  endSpan(span: ActiveSpan, status?: LunaSpanStatus): Promise<void>;
  withSpan<T>(input: StartSpanInput, run: (span: ActiveSpan) => Promise<T> | T): Promise<T>;
  addEvent(name: string, attributes?: Record<string, unknown>): Promise<void>;
  log(input: Omit<LunaDiagnosticLog, "timestamp" | "trace_id" | "span_id" | "attributes"> & {
    attributes?: Record<string, unknown>;
  }): Promise<void>;
  emit(record: LunaTelemetryRecord): Promise<void>;
  close(): Promise<void>;
  isHardFailed(): boolean;
  hardFailure(): ObservabilityEmitError | undefined;
};

export type CreateObservabilityRecorderOptions = {
  run: {
    id: string;
    workflowId: string;
    attempt: number;
  };
  sinks: readonly ObservabilitySink[];
  now?: () => Date;
  idGenerator?: () => string;
};

export type ObservabilityEmitError = Error & {
  code: "observability_emit_failed";
  hardFailure: true;
  sinkId: string;
  cause: unknown;
};

type SpanContext = {
  traceId: string;
  activeSpan?: ActiveSpan;
};

function emitError(sink: ObservabilitySink, cause: unknown): ObservabilityEmitError {
  const error = new Error("Failed to emit observability record", {
    cause
  }) as ObservabilityEmitError;
  error.code = "observability_emit_failed";
  error.hardFailure = true;
  error.sinkId = sink.id;
  error.cause = cause;
  return error;
}

function cloneSpan(span: LunaSpan): LunaSpan {
  return {
    ...span,
    attributes: { ...span.attributes },
    metadata: { ...span.metadata },
    ...(span.usage === undefined
      ? {}
      : {
          usage: {
            ...span.usage,
            ...(span.usage.cost === undefined ? {} : { cost: { ...span.usage.cost } })
          }
        }),
    ...(span.error === undefined
      ? {}
      : {
          error: {
            ...span.error,
            ...(span.error.details === undefined ? {} : { details: { ...span.error.details } })
          }
        })
  };
}

function normalizeUsage(usage: LunaUsage): LunaUsage {
  return {
    input_tokens: nonnegativeNumber(usage.input_tokens),
    output_tokens: nonnegativeNumber(usage.output_tokens),
    cache_read_tokens: nonnegativeNumber(usage.cache_read_tokens),
    cache_write_tokens: nonnegativeNumber(usage.cache_write_tokens),
    total_tokens: nonnegativeNumber(usage.total_tokens),
    ...(usage.rollup === undefined ? {} : { rollup: usage.rollup }),
    ...(usage.cost === undefined
      ? {}
      : {
          cost: {
            input: nonnegativeNumber(usage.cost.input),
            output: nonnegativeNumber(usage.cost.output),
            cache_read: nonnegativeNumber(usage.cost.cache_read),
            cache_write: nonnegativeNumber(usage.cost.cache_write),
            total: nonnegativeNumber(usage.cost.total),
            unit: "provider_cost_unit"
          }
        })
  };
}

function nonnegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function errorFrom(cause: unknown): LunaSpanError {
  if (cause instanceof Error) {
    const maybeCode = (cause as { code?: unknown }).code;
    const maybeDetails = (cause as { details?: unknown }).details;
    return {
      ...(typeof maybeCode === "string" ? { code: maybeCode } : {}),
      message: cause.message,
      type: cause.name,
      ...(maybeDetails === undefined
        ? {}
        : { details: sanitizeJsonObject({ details: maybeDetails }).details as JsonObject })
    };
  }

  return {
    message: typeof cause === "string" ? cause : "Unknown error",
    details: sanitizeJsonObject({ cause })
  };
}

export function createObservabilityRecorder({
  run,
  sinks,
  now = () => new Date(),
  idGenerator = () => randomUUID()
}: CreateObservabilityRecorderOptions): ObservabilityRecorder {
  const requiredSinks = sinks.filter((sink) => sink.required);
  const optionalSinks = sinks.filter((sink) => !sink.required);
  const storage = new AsyncLocalStorage<SpanContext>();
  let hardFailure: ObservabilityEmitError | undefined;
  let tail = Promise.resolve();

  async function emit(record: LunaTelemetryRecord): Promise<void> {
    if (hardFailure !== undefined) {
      throw hardFailure;
    }

    const next = tail.then(async () => {
      if (hardFailure !== undefined) {
        throw hardFailure;
      }

      for (const sink of requiredSinks) {
        try {
          await sink.emit(record);
        } catch (cause) {
          hardFailure = emitError(sink, cause);
          throw hardFailure;
        }
      }

      for (const sink of optionalSinks) {
        try {
          await sink.emit(record);
        } catch {
          // Optional exporters must never disturb the primary execution trace.
        }
      }
    });

    tail = next.catch(() => undefined);
    await next;
  }

  function activeContext(): SpanContext {
    const current = storage.getStore();
    if (current !== undefined) {
      return current;
    }

    return { traceId: idGenerator() };
  }

  async function startSpan(input: StartSpanInput): Promise<ActiveSpan> {
    const context = activeContext();
    const parent = context.activeSpan?.span;
    const span: LunaSpan = {
      schema_version: 1,
      trace_id: context.traceId,
      span_id: idGenerator(),
      ...(parent === undefined ? {} : { parent_span_id: parent.span_id }),
      run_id: run.id,
      workflow_id: run.workflowId,
      attempt: run.attempt,
      name: input.name,
      kind: input.kind,
      status: input.status ?? "ok",
      started_at: now().toISOString(),
      ...(input.nodeId === undefined ? {} : { node_id: input.nodeId }),
      ...(input.capabilityId === undefined ? {} : { capability_id: input.capabilityId }),
      ...(input.agentId === undefined ? {} : { agent_id: input.agentId }),
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.model === undefined ? {} : { model: input.model }),
      attributes: { ...(input.attributes ?? {}) },
      metadata: sanitizeJsonObject(input.metadata ?? {})
    };
    const active: ActiveSpan = {
      span,
      async addEvent(name, attributes = {}) {
        const event: LunaSpanEvent = {
          name,
          timestamp: now().toISOString(),
          attributes: sanitizeJsonObject(attributes)
        };
        await emit({
          type: "span.event",
          trace_id: span.trace_id,
          span_id: span.span_id,
          event
        });
      },
      setAttribute: (key, value) => {
        span.attributes[key] = value;
      },
      setMetadata: (key, value) => {
        span.metadata[key] = sanitizeJsonObject({ value }).value;
      },
      setUsage: (usage) => {
        span.usage = normalizeUsage(usage);
      },
      setStatus: (status) => {
        span.status = status;
      }
    };

    await emit({ type: "span.started", span: cloneSpan(span) });
    return active;
  }

  async function endSpan(active: ActiveSpan, status?: LunaSpanStatus): Promise<void> {
    if (active.span.ended_at !== undefined) {
      return;
    }

    const ended = now();
    active.span.status = status ?? active.span.status;
    active.span.ended_at = ended.toISOString();
    active.span.duration_ms = Math.max(
      0,
      ended.getTime() - Date.parse(active.span.started_at)
    );
    await emit({ type: "span.ended", span: cloneSpan(active.span) });
  }

  async function withSpan<T>(
    input: StartSpanInput,
    operation: (span: ActiveSpan) => Promise<T> | T
  ): Promise<T> {
    const parentContext = storage.getStore();
    const active = await startSpan(input);
    const childContext = {
      traceId: active.span.trace_id,
      activeSpan: active
    };

    try {
      const result = await storage.run(childContext, async () => await operation(active));
      await endSpan(active, active.span.status);
      return result;
    } catch (cause) {
      active.span.status = "error";
      active.span.error = errorFrom(cause);
      await endSpan(active, "error");
      throw cause;
    } finally {
      if (parentContext !== undefined) {
        storage.enterWith(parentContext);
      }
    }
  }

  return {
    startSpan,
    endSpan,
    withSpan,
    async addEvent(name, attributes) {
      const active = storage.getStore()?.activeSpan;
      if (active !== undefined) {
        await active.addEvent(name, attributes);
      }
    },
    async log(input) {
      const active = storage.getStore()?.activeSpan;
      await emit({
        type: "log",
        log: {
          timestamp: now().toISOString(),
          level: input.level,
          message: input.message,
          ...(active === undefined ? {} : { trace_id: active.span.trace_id, span_id: active.span.span_id }),
          ...(input.node_id === undefined ? {} : { node_id: input.node_id }),
          attributes: sanitizeJsonObject(input.attributes ?? {})
        }
      });
    },
    emit,
    async close() {
      await tail;
      for (const sink of requiredSinks) {
        try {
          await sink.flush?.();
        } catch (cause) {
          hardFailure = emitError(sink, cause);
          throw hardFailure;
        }
      }
      for (const sink of optionalSinks) {
        try {
          await sink.flush?.();
        } catch {
          // Optional exporters must never disturb the primary execution trace.
        }
      }
    },
    isHardFailed: () => hardFailure !== undefined,
    hardFailure: () => hardFailure
  };
}
