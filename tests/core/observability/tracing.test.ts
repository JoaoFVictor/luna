import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createObservabilityRecorder,
  createSummaryProjection,
  type LunaTelemetryRecord,
  type ObservabilitySink
} from "../../../src/core/observability/tracing.js";
import { createWorkflowObservability } from "../../../src/core/observability/workflow-observability.js";
import { createJsonlTraceSink } from "../../../src/core/observability/sinks.js";

describe("enterprise observability tracing", () => {
  it("records a causal span tree with attributes, events, usage, and derived summary", async () => {
    const records: LunaTelemetryRecord[] = [];
    const sink: ObservabilitySink = {
      id: "memory",
      required: true,
      emit: (record) => {
        records.push(record);
      }
    };
    const now = vi
      .fn<() => Date>()
      .mockReturnValueOnce(new Date("2026-06-28T10:00:00.000Z"))
      .mockReturnValueOnce(new Date("2026-06-28T10:00:00.010Z"))
      .mockReturnValueOnce(new Date("2026-06-28T10:00:00.025Z"))
      .mockReturnValueOnce(new Date("2026-06-28T10:00:00.030Z"))
      .mockReturnValueOnce(new Date("2026-06-28T10:00:00.040Z"));
    const recorder = createObservabilityRecorder({
      run: { id: "run-1", workflowId: "workflow-1", attempt: 2 },
      sinks: [sink],
      now,
      idGenerator: vi
        .fn<() => string>()
        .mockReturnValueOnce("trace-1")
        .mockReturnValueOnce("span-workflow")
        .mockReturnValueOnce("span-agent")
    });

    await recorder.withSpan(
      {
        name: "workflow.run",
        kind: "workflow",
        attributes: { "luna.runtime": "native" }
      },
      async () => {
        await recorder.withSpan(
          {
            name: "agent.change-reviewer",
            kind: "agent",
            nodeId: "review",
            agentId: "change-reviewer",
            provider: "openai",
            model: "gpt-5",
            attributes: { "luna.node.kind": "agent" }
          },
          async (span) => {
            await span.addEvent("llm.response", {
              response_id: "resp-1",
              provider_payload: { secret: "must redact" }
            });
            span.setUsage({
              input_tokens: 11,
              output_tokens: 7,
              cache_read_tokens: 3,
              cache_write_tokens: 0,
              total_tokens: 21,
              cost: {
                input: 1,
                output: 2,
                cache_read: 0.5,
                cache_write: 0,
                total: 3.5,
                unit: "provider_cost_unit"
              }
            });
          }
        );
      }
    );

    await recorder.close();

    expect(records.map((record) => record.type)).toEqual([
      "span.started",
      "span.started",
      "span.event",
      "span.ended",
      "span.ended"
    ]);
    const agentEnded = records.find(
      (record) => record.type === "span.ended" && record.span.kind === "agent"
    );
    expect(agentEnded).toMatchObject({
      span: {
        trace_id: "trace-1",
        span_id: "span-agent",
        parent_span_id: "span-workflow",
        run_id: "run-1",
        workflow_id: "workflow-1",
        attempt: 2,
        status: "ok",
        duration_ms: 20,
        node_id: "review",
        agent_id: "change-reviewer",
        provider: "openai",
        model: "gpt-5",
        attributes: {
          "luna.node.kind": "agent"
        },
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cache_read_tokens: 3,
          cache_write_tokens: 0,
          total_tokens: 21
        }
      }
    });
    expect(records[2]).toMatchObject({
      type: "span.event",
      event: {
        name: "llm.response",
        attributes: {
          response_id: "resp-1",
          provider_payload: "[REDACTED]"
        }
      }
    });
    expect(createSummaryProjection(records)).toMatchObject({
      schema_version: 2,
      run_id: "run-1",
      workflow_id: "workflow-1",
      spans: {
        total: 2,
        failed: 0
      },
      prompt_operations: 1,
      tokens: {
        input: 11,
        output: 7,
        cache_read: 3,
        cache_write: 0,
        total: 21
      },
      cost: {
        input: 1,
        output: 2,
        cache_read: 0.5,
        cache_write: 0,
        total: 3.5
      }
    });
  });

  it("rolls up usage from leaf LLM spans without double-counting agent aggregate usage", async () => {
    const records: LunaTelemetryRecord[] = [];
    const recorder = createObservabilityRecorder({
      run: { id: "run-usage", workflowId: "workflow-usage", attempt: 1 },
      sinks: [
        {
          id: "memory",
          required: true,
          emit(record) {
            records.push(record);
          }
        }
      ],
      now: vi
        .fn<() => Date>()
        .mockReturnValueOnce(new Date("2026-06-28T10:00:00.000Z"))
        .mockReturnValueOnce(new Date("2026-06-28T10:00:00.010Z"))
        .mockReturnValueOnce(new Date("2026-06-28T10:00:00.020Z"))
        .mockReturnValueOnce(new Date("2026-06-28T10:00:00.030Z")),
      idGenerator: vi
        .fn<() => string>()
        .mockReturnValueOnce("trace-usage")
        .mockReturnValueOnce("span-agent")
        .mockReturnValueOnce("span-llm")
    });

    await recorder.withSpan({ name: "agent.writer", kind: "agent" }, async (agentSpan) => {
      agentSpan.setUsage({
        input_tokens: 100,
        output_tokens: 40,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 140,
        rollup: "exclude"
      });
      await recorder.withSpan({ name: "llm.complete", kind: "llm" }, async (llmSpan) => {
        llmSpan.setUsage({
          input_tokens: 100,
          output_tokens: 40,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          total_tokens: 140
        });
      });
    });

    const summary = createSummaryProjection(records);

    expect(summary.prompt_operations).toBe(1);
    expect(summary.tokens).toMatchObject({
      input: 100,
      output: 40,
      cache_read: 0,
      cache_write: 0,
      total: 140
    });
  });

  it("rolls up aggregate fallback usage when no provider-call child usage exists", async () => {
    const records: LunaTelemetryRecord[] = [];
    const recorder = createObservabilityRecorder({
      run: { id: "run-agent-usage", workflowId: "workflow-usage", attempt: 1 },
      sinks: [
        {
          id: "memory",
          required: true,
          emit(record) {
            records.push(record);
          }
        }
      ],
      idGenerator: vi
        .fn<() => string>()
        .mockReturnValueOnce("trace-agent-usage")
        .mockReturnValueOnce("span-agent")
        .mockReturnValueOnce("span-llm")
    });

    await recorder.withSpan({ name: "agent.writer", kind: "agent" }, async (agentSpan) => {
      agentSpan.setUsage({
        input_tokens: 30,
        output_tokens: 12,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 42,
        rollup: "aggregate_fallback"
      });
      await recorder.withSpan({ name: "llm.complete", kind: "llm" }, async () => undefined);
    });

    const summary = createSummaryProjection(records);

    expect(summary.prompt_operations).toBe(1);
    expect(summary.usage_missing_count).toBe(0);
    expect(summary.tokens.total).toBe(42);
  });

  it("marks failed spans and fails fast after a required sink failure", async () => {
    const sinkError = new Error("collector unavailable");
    const recorder = createObservabilityRecorder({
      run: { id: "run-1", workflowId: "workflow-1", attempt: 1 },
      sinks: [
        {
          id: "required",
          required: true,
          emit: () => {
            throw sinkError;
          }
        }
      ],
      now: () => new Date("2026-06-28T10:00:00.000Z"),
      idGenerator: vi.fn<() => string>().mockReturnValueOnce("trace-1").mockReturnValue("span-1")
    });

    await expect(
      recorder.withSpan({ name: "workflow.run", kind: "workflow" }, async () => undefined)
    ).rejects.toMatchObject({
      code: "observability_emit_failed",
      sinkId: "required",
      hardFailure: true
    });
    await expect(
      recorder.withSpan({ name: "workflow.after", kind: "workflow" }, async () => undefined)
    ).rejects.toBe(recorder.hardFailure());
  });

  it("applies required and optional sink policy to flush", async () => {
    const optionalFlush = vi.fn<() => Promise<void>>(async () => {
      throw new Error("optional flush unavailable");
    });
    const requiredFlush = vi.fn<() => Promise<void>>(async () => undefined);
    const recorder = createObservabilityRecorder({
      run: { id: "run-flush", workflowId: "workflow-flush", attempt: 1 },
      sinks: [
        {
          id: "optional",
          required: false,
          emit() {},
          flush: optionalFlush
        },
        {
          id: "required",
          required: true,
          emit() {},
          flush: requiredFlush
        }
      ]
    });

    await expect(recorder.close()).resolves.toBeUndefined();
    expect(optionalFlush).toHaveBeenCalledOnce();
    expect(requiredFlush).toHaveBeenCalledOnce();

    const requiredFailure = new Error("required flush unavailable");
    const failingRecorder = createObservabilityRecorder({
      run: { id: "run-required-flush", workflowId: "workflow-flush", attempt: 1 },
      sinks: [
        {
          id: "required",
          required: true,
          emit() {},
          flush: async () => {
            throw requiredFailure;
          }
        }
      ]
    });

    await expect(failingRecorder.close()).rejects.toMatchObject({
      code: "observability_emit_failed",
      sinkId: "required",
      hardFailure: true
    });
  });

  it("owns the telemetry buffer inside workflow observability", async () => {
    const externalRecords: LunaTelemetryRecord[] = [];
    const observability = createWorkflowObservability({
      run: { id: "run-workflow-observability", workflowId: "workflow-observability", attempt: 1 },
      sinks: [
        {
          id: "external",
          required: true,
          emit(record) {
            externalRecords.push(record);
          }
        }
      ],
      idGenerator: vi
        .fn<() => string>()
        .mockReturnValueOnce("trace-workflow-observability")
        .mockReturnValueOnce("span-workflow")
    });

    await observability.recorder.withSpan(
      { name: "workflow.run", kind: "workflow" },
      async () => undefined
    );

    expect(observability.records().map((record) => record.type)).toEqual([
      "span.started",
      "span.ended"
    ]);
    expect(externalRecords.map((record) => record.type)).toEqual([
      "span.started",
      "span.ended"
    ]);
    expect(observability.snapshotSummary()).toMatchObject({
      run_id: "run-workflow-observability",
      spans: { total: 1 }
    });
  });

  it("exports trace records as structured JSONL", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-trace-jsonl-"));
    const filePath = path.join(root, "trace.jsonl");
    const recorder = createObservabilityRecorder({
      run: { id: "run-jsonl", workflowId: "workflow-jsonl", attempt: 1 },
      sinks: [createJsonlTraceSink({ filePath })],
      now: vi
        .fn<() => Date>()
        .mockReturnValueOnce(new Date("2026-06-28T10:00:00.000Z"))
        .mockReturnValueOnce(new Date("2026-06-28T10:00:00.010Z")),
      idGenerator: vi
        .fn<() => string>()
        .mockReturnValueOnce("trace-jsonl")
        .mockReturnValueOnce("span-jsonl")
    });

    await recorder.withSpan({ name: "workflow.run", kind: "workflow" }, async () => undefined);
    await recorder.close();

    const lines = (await readFile(filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      expect.objectContaining({
        type: "span.started",
        span: expect.objectContaining({ trace_id: "trace-jsonl", span_id: "span-jsonl" })
      }),
      expect.objectContaining({
        type: "span.ended",
        span: expect.objectContaining({ status: "ok", duration_ms: 10 })
      })
    ]);
  });
});
