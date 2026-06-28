import { describe, expect, it, vi } from "vitest";
import {
  createLangSmithTraceSink,
  createOpenTelemetryTraceSink
} from "../../../src/core/observability/exporters.js";
import type { LunaTelemetryRecord } from "../../../src/core/observability/tracing.js";

const started = {
  type: "span.started",
  span: {
    schema_version: 1,
    trace_id: "trace-1",
    span_id: "span-1",
    parent_span_id: "parent-1",
    run_id: "run-1",
    workflow_id: "workflow-1",
    attempt: 1,
    name: "llm.complete",
    kind: "llm",
    status: "ok",
    started_at: "2026-06-28T00:00:00.000Z",
    node_id: "review",
    agent_id: "reviewer",
    provider: "openai",
    model: "gpt-5",
    attributes: { "gen_ai.system": "openai" },
    metadata: { response_id: "resp-1" }
  }
} satisfies LunaTelemetryRecord;

const ended = {
  type: "span.ended",
  span: {
    ...started.span,
    ended_at: "2026-06-28T00:00:00.123Z",
    duration_ms: 123,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 15
    }
  }
} satisfies LunaTelemetryRecord;

describe("observability exporters", () => {
  it("maps Luna spans to LangSmith parented runs with tags and metadata", async () => {
    const client = {
      createRun: vi.fn(),
      updateRun: vi.fn()
    };
    const sink = createLangSmithTraceSink({ client, required: true });

    await sink.emit(started);
    await sink.emit(ended);

    expect(client.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "span-1",
        trace_id: "trace-1",
        parent_run_id: "parent-1",
        name: "llm.complete",
        run_type: "llm",
        tags: expect.arrayContaining([
          "luna.kind:llm",
          "workflow:workflow-1",
          "node:review",
          "agent:reviewer",
          "provider:openai",
          "model:gpt-5"
        ]),
        metadata: expect.objectContaining({
          run_id: "run-1",
          workflow_id: "workflow-1",
          usage: undefined
        })
      })
    );
    expect(client.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "span-1",
        end_time: "2026-06-28T00:00:00.123Z",
        outputs: expect.objectContaining({
          status: "ok",
          duration_ms: 123,
          usage: ended.span.usage
        })
      })
    );
  });

  it("maps Luna spans and span events to an OpenTelemetry bridge", async () => {
    const bridge = {
      startSpan: vi.fn(),
      addEvent: vi.fn(),
      endSpan: vi.fn()
    };
    const sink = createOpenTelemetryTraceSink({ bridge });

    await sink.emit(started);
    await sink.emit({
      type: "span.event",
      trace_id: "trace-1",
      span_id: "span-1",
      event: {
        name: "llm.response",
        timestamp: "2026-06-28T00:00:00.050Z",
        attributes: { response_id: "resp-1" }
      }
    });
    await sink.emit(ended);

    expect(bridge.startSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "trace-1",
        spanId: "span-1",
        parentSpanId: "parent-1",
        name: "llm.complete",
        attributes: expect.objectContaining({
          "luna.run_id": "run-1",
          "luna.workflow_id": "workflow-1",
          "gen_ai.system": "openai",
          "gen_ai.request.model": "gpt-5"
        })
      })
    );
    expect(bridge.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "trace-1",
        spanId: "span-1",
        event: expect.objectContaining({ name: "llm.response" })
      })
    );
    expect(bridge.endSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "trace-1",
        spanId: "span-1",
        status: "ok"
      })
    );
  });
});
