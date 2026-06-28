import type {
  LunaSpan,
  LunaSpanEvent,
  LunaTelemetryRecord,
  ObservabilitySink
} from "./tracing.js";

export type LangSmithRunType =
  | "chain"
  | "llm"
  | "tool"
  | "retriever"
  | "embedding"
  | "prompt"
  | "parser";

export type LangSmithTraceClient = {
  createRun(input: {
    id: string;
    trace_id: string;
    parent_run_id?: string;
    name: string;
    run_type: LangSmithRunType;
    start_time: string;
    tags: string[];
    metadata: Record<string, unknown>;
    inputs?: Record<string, unknown>;
  }): Promise<void> | void;
  updateRun(input: {
    id: string;
    end_time: string;
    error?: string;
    outputs?: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }): Promise<void> | void;
};

export function createLangSmithTraceSink({
  client,
  id = "langsmith",
  required = false
}: {
  client: LangSmithTraceClient;
  id?: string;
  required?: boolean;
}): ObservabilitySink {
  return {
    id,
    required,
    async emit(record) {
      if (record.type === "span.started") {
        await client.createRun(langSmithCreateRun(record.span));
      }
      if (record.type === "span.ended") {
        await client.updateRun(langSmithUpdateRun(record.span));
      }
    }
  };
}

export type OpenTelemetrySpanBridge = {
  startSpan(input: {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    kind: LunaSpan["kind"];
    startTime: string;
    attributes: Record<string, string | number | boolean>;
  }): Promise<void> | void;
  addEvent(input: {
    traceId: string;
    spanId: string;
    event: LunaSpanEvent;
  }): Promise<void> | void;
  endSpan(input: {
    traceId: string;
    spanId: string;
    endTime: string;
    status: LunaSpan["status"];
    error?: LunaSpan["error"];
    attributes: Record<string, string | number | boolean>;
  }): Promise<void> | void;
};

export function createOpenTelemetryTraceSink({
  bridge,
  id = "opentelemetry",
  required = false
}: {
  bridge: OpenTelemetrySpanBridge;
  id?: string;
  required?: boolean;
}): ObservabilitySink {
  return {
    id,
    required,
    async emit(record: LunaTelemetryRecord) {
      if (record.type === "span.started") {
        await bridge.startSpan({
          traceId: record.span.trace_id,
          spanId: record.span.span_id,
          parentSpanId: record.span.parent_span_id,
          name: record.span.name,
          kind: record.span.kind,
          startTime: record.span.started_at,
          attributes: otelAttributes(record.span)
        });
      }
      if (record.type === "span.event") {
        await bridge.addEvent({
          traceId: record.trace_id,
          spanId: record.span_id,
          event: record.event
        });
      }
      if (record.type === "span.ended") {
        await bridge.endSpan({
          traceId: record.span.trace_id,
          spanId: record.span.span_id,
          endTime: record.span.ended_at ?? record.span.started_at,
          status: record.span.status,
          error: record.span.error,
          attributes: otelAttributes(record.span)
        });
      }
    }
  };
}

function langSmithCreateRun(span: LunaSpan): Parameters<LangSmithTraceClient["createRun"]>[0] {
  return {
    id: span.span_id,
    trace_id: span.trace_id,
    ...(span.parent_span_id === undefined ? {} : { parent_run_id: span.parent_span_id }),
    name: span.name,
    run_type: langSmithRunType(span.kind),
    start_time: span.started_at,
    tags: langSmithTags(span),
    metadata: langSmithMetadata(span),
    inputs: span.metadata
  };
}

function langSmithUpdateRun(span: LunaSpan): Parameters<LangSmithTraceClient["updateRun"]>[0] {
  return {
    id: span.span_id,
    end_time: span.ended_at ?? span.started_at,
    ...(span.error === undefined ? {} : { error: span.error.message }),
    outputs: {
      status: span.status,
      duration_ms: span.duration_ms,
      usage: span.usage
    },
    metadata: langSmithMetadata(span)
  };
}

function langSmithRunType(kind: LunaSpan["kind"]): LangSmithRunType {
  if (kind === "llm") {
    return "llm";
  }
  if (kind === "tool") {
    return "tool";
  }
  if (kind === "agent" || kind === "workflow" || kind === "node" || kind === "gate") {
    return "chain";
  }

  return "chain";
}

function langSmithTags(span: LunaSpan): string[] {
  return [
    `luna.kind:${span.kind}`,
    `workflow:${span.workflow_id}`,
    ...(span.node_id === undefined ? [] : [`node:${span.node_id}`]),
    ...(span.agent_id === undefined ? [] : [`agent:${span.agent_id}`]),
    ...(span.provider === undefined ? [] : [`provider:${span.provider}`]),
    ...(span.model === undefined ? [] : [`model:${span.model}`])
  ];
}

function langSmithMetadata(span: LunaSpan): Record<string, unknown> {
  return {
    run_id: span.run_id,
    workflow_id: span.workflow_id,
    attempt: span.attempt,
    kind: span.kind,
    status: span.status,
    node_id: span.node_id,
    capability_id: span.capability_id,
    agent_id: span.agent_id,
    provider: span.provider,
    model: span.model,
    attributes: span.attributes,
    metadata: span.metadata,
    usage: span.usage,
    error: span.error
  };
}

function otelAttributes(span: LunaSpan): Record<string, string | number | boolean> {
  return {
    ...span.attributes,
    "luna.trace_id": span.trace_id,
    "luna.span_id": span.span_id,
    "luna.run_id": span.run_id,
    "luna.workflow_id": span.workflow_id,
    "luna.span.kind": span.kind,
    "luna.span.status": span.status,
    "luna.attempt": span.attempt,
    ...(span.node_id === undefined ? {} : { "luna.node_id": span.node_id }),
    ...(span.capability_id === undefined
      ? {}
      : { "luna.capability_id": span.capability_id }),
    ...(span.agent_id === undefined ? {} : { "luna.agent_id": span.agent_id }),
    ...(span.provider === undefined ? {} : { "gen_ai.system": span.provider }),
    ...(span.model === undefined ? {} : { "gen_ai.request.model": span.model })
  };
}
