import { describe, expect, it, vi } from "vitest";
import {
  createLunaObservability,
  customEvent,
  runCompletedEvent,
  type LunaEvent,
  type LunaObservability,
  type LunaObservabilityLevel,
  type LunaObservabilitySink
} from "../../src/core/observability/luna-observability.js";
import { createObservabilitySinks } from "../../src/core/observability/exporter-config.js";
import { sanitizeJsonObject } from "../../src/core/observability/sanitize.js";

function baseOptions(sinks: LunaObservabilitySink[]) {
  return {
    run: { id: "run-1", runtimeRunId: "runtime-1", attempt: 2 },
    workflow: { id: "code-review" },
    sinks,
    now: () => new Date("2026-06-20T12:00:00.000Z")
  };
}

function testEvent(
  observability: LunaObservability,
  severity: LunaObservabilityLevel,
  type: string,
  data?: Record<string, unknown>
): LunaEvent {
  return customEvent({
    ...observability.eventContext(severity),
    type,
    ...(data === undefined ? {} : { data: sanitizeJsonObject(data) })
  });
}

describe("Luna observability", () => {
  it("always includes jsonl as required and appends enabled runtime_log sinks", () => {
    const jsonlSink: LunaObservabilitySink = {
      id: "original-jsonl",
      append: async () => undefined
    };
    const runtimeLogSink: LunaObservabilitySink = {
      id: "original-runtime",
      append: async () => undefined
    };

    const sinks = createObservabilitySinks({
      config: {
        exporters: {
          runtime_log: { enabled: true, required: false }
        }
      },
      jsonlSink,
      runtimeLogSinks: [runtimeLogSink]
    });

    expect(sinks).toEqual([
      expect.objectContaining({ id: "jsonl", required: true }),
      expect.objectContaining({ id: "runtime_log", required: false })
    ]);
  });

  it("omits disabled runtime_log but keeps jsonl", () => {
    const jsonlSink: LunaObservabilitySink = {
      id: "original-jsonl",
      append: async () => undefined
    };
    const runtimeLogSink: LunaObservabilitySink = {
      id: "original-runtime",
      append: async () => undefined
    };

    const sinks = createObservabilitySinks({
      config: {
        exporters: {
          runtime_log: { enabled: false, required: false }
        }
      },
      jsonlSink,
      runtimeLogSinks: [runtimeLogSink]
    });

    expect(sinks.map((sink) => sink.id)).toEqual(["jsonl"]);
    expect(sinks[0]).toMatchObject({ required: true });
  });

  it("fails when runtime_log is required but unavailable", () => {
    const jsonlSink: LunaObservabilitySink = {
      id: "original-jsonl",
      append: async () => undefined
    };

    expect(() =>
      createObservabilitySinks({
        config: {
          exporters: {
            runtime_log: { enabled: true, required: true }
          }
        },
        jsonlSink
      })
    ).toThrow("Required observability exporter runtime_log is unavailable");
  });

  it("decorates events with the normalized Luna event contract", async () => {
    const events: LunaEvent[] = [];
    const observability = createLunaObservability(
      baseOptions([
        {
          id: "memory",
          required: true,
          append: async (event) => {
            events.push(event);
          }
        }
      ])
    );

    await observability.emit(
      customEvent({
        ...observability.eventContext("info"),
        type: "luna.test.event",
        step: { id: "plan", type: "agent" },
        outcome: { status: "succeeded" },
        data: sanitizeJsonObject({
          agent_id: "reviewer",
          subagent_id: "helper",
          prompt_id: "prompt-1",
          duration_ms: 12,
          ok: true
        })
      })
    );

    expect(events).toEqual([
      {
        type: "luna.test.event",
        severity: "info",
        timestamp: "2026-06-20T12:00:00.000Z",
        run: { id: "run-1", runtimeRunId: "runtime-1", attempt: 2 },
        workflow: { id: "code-review" },
        step: { id: "plan", type: "agent" },
        outcome: { status: "succeeded" },
        data: {
          agent_id: "reviewer",
          subagent_id: "helper",
          prompt_id: "prompt-1",
          duration_ms: 12,
          ok: true
        }
      }
    ]);
    expect(events[0]).not.toHaveProperty("event");
    expect(events[0]).not.toHaveProperty("run_id");
    expect(events[0]).not.toHaveProperty("workflow_id");
  });

  it("redacts prompt and provider payload variants and sanitizes circular, bigint, and Error values", async () => {
    const events: LunaEvent[] = [];
    const circular: Record<string, unknown> = { ok: true };
    circular.self = circular;
    const observability = createLunaObservability(
      baseOptions([
        {
          id: "memory",
          required: true,
          append: async (event) => {
            events.push(event);
          }
        }
      ])
    );

    await observability.emit(
      testEvent(observability, "info", "luna.prompt.completed", {
        token: "token-value",
        prompt: "raw prompt",
        systemPrompt: "system prompt",
        prompt_text: "prompt text",
        provider_payload: { nested: "raw" },
        providerPayload: { nested: "camel" },
        "provider.payload": { nested: "dotted" },
        count: 2n,
        error: new Error("Authorization: Bearer token-value"),
        circular
      })
    );

    expect(events[0]).toMatchObject({
      data: {
        error: {
          name: "Error",
          message: "Authorization: Bearer [REDACTED]"
        },
        token: "[REDACTED]",
        prompt: "[REDACTED]",
        systemPrompt: "[REDACTED]",
        prompt_text: "[REDACTED]",
        provider_payload: "[REDACTED]",
        providerPayload: "[REDACTED]",
        "provider.payload": "[REDACTED]",
        count: "2",
        circular: {
          ok: true,
          self: "[Circular]"
        }
      }
    });
  });

  it("sanitizes an Error whose cause references itself", async () => {
    const events: LunaEvent[] = [];
    const circularError = new Error("loop");
    circularError.cause = circularError;
    const observability = createLunaObservability(
      baseOptions([
        {
          id: "memory",
          required: true,
          append: async (event) => {
            events.push(event);
          }
        }
      ])
    );

    await observability.emit(
      testEvent(observability, "warn", "luna.test.circular-error", {
        error: circularError
      })
    );

    expect(events[0]?.data?.error).toMatchObject({
      name: "Error",
      message: "loop",
      cause: "[Circular]"
    });
    expect(() => JSON.stringify(events[0])).not.toThrow();
  });

  it("serializes concurrent emits and optional sink warnings in required sink order", async () => {
    const releases: Array<() => void> = [];
    const requiredEvents: LunaEvent[] = [];
    const observability = createLunaObservability(
      baseOptions([
        {
          id: "optional",
          required: false,
          append: async (event) => {
            if (event.type === "first") {
              throw new Error("network unavailable");
            }
          }
        },
        {
          id: "required",
          required: true,
          append: async (event) => {
            await new Promise<void>((resolve) => {
              releases.push(resolve);
            });
            requiredEvents.push(event);
          }
        }
      ])
    );

    const first = observability.emit(testEvent(observability, "info", "first"));
    const second = observability.emit(
      testEvent(observability, "info", "second")
    );

    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();

    await Promise.all([first, second]);

    expect(requiredEvents.map((event) => event.type)).toEqual([
      "first",
      "luna.observability.sink.warning",
      "second"
    ]);
    expect(requiredEvents[1]).toMatchObject({
      outcome: { status: "skipped" },
      data: {
        sink_id: "optional",
        required: false,
        error: {
          name: "Error",
          message: "network unavailable"
        }
      }
    });
  });

  it("serializes concurrent emits so sink writes stay ordered", async () => {
    const releases: Array<() => void> = [];
    const written: number[] = [];
    const observability = createLunaObservability(
      baseOptions([
        {
          id: "slow",
          required: true,
          append: async (event) => {
            await new Promise<void>((resolve) => {
              releases.push(resolve);
            });
            written.push(event.type === "first" ? 1 : 2);
          }
        }
      ])
    );

    const first = observability.emit(testEvent(observability, "info", "first"));
    const second = observability.emit(
      testEvent(observability, "info", "second")
    );

    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();

    await Promise.all([first, second]);

    expect(written).toEqual([1, 2]);
  });

  it("fails hard when a required sink append fails and later emits fail fast", async () => {
    const observability = createLunaObservability(
      baseOptions([
        {
          id: "required-jsonl",
          required: true,
          append: async () => {
            throw new Error("disk full");
          }
        }
      ])
    );

    await expect(
      observability.emit(
        runCompletedEvent({
          ...observability.eventContext("error"),
          status: "failed"
        })
      )
    ).rejects.toMatchObject({
      code: "observability_append_failed",
      hardFailure: true,
      sinkId: "required-jsonl"
    });
    expect(observability.isHardFailed()).toBe(true);
    expect(observability.hardFailure()).toMatchObject({
      code: "observability_append_failed",
      hardFailure: true,
      sinkId: "required-jsonl"
    });
    await expect(
      observability.emit(testEvent(observability, "info", "after-failure"))
    ).rejects.toBe(observability.hardFailure());
  });

  it("close waits for queued events and preserves hard failure state", async () => {
    const events: LunaEvent[] = [];
    const observability = createLunaObservability(
      baseOptions([
        {
          id: "memory",
          required: true,
          append: async (event) => {
            events.push(event);
          }
        }
      ])
    );

    const pending = observability.emit(
      testEvent(observability, "info", "queued")
    );

    await expect(observability.close()).resolves.toBeUndefined();
    await pending;

    expect(events.map((event) => event.type)).toEqual(["queued"]);
    expect(observability.isHardFailed()).toBe(false);
    expect(observability.hardFailure()).toBeUndefined();
  });

  it("emits optional sink failures as warnings through required sinks when possible", async () => {
    const requiredEvents: LunaEvent[] = [];
    const observability = createLunaObservability(
      baseOptions([
        {
          id: "optional",
          required: false,
          append: async () => {
            throw new Error("network unavailable");
          }
        },
        {
          id: "required",
          required: true,
          append: async (event) => {
            requiredEvents.push(event);
          }
        }
      ])
    );

    await observability.emit(
      testEvent(observability, "info", "luna.test.event", { ok: true })
    );

    expect(requiredEvents.map((event) => event.type)).toEqual([
      "luna.test.event",
      "luna.observability.sink.warning"
    ]);
    expect(requiredEvents[1]).toMatchObject({
      outcome: { status: "skipped" },
      data: {
        sink_id: "optional",
        required: false,
        error: {
          name: "Error",
          message: "network unavailable"
        }
      }
    });
  });
});
