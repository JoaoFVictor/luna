import { describe, expect, it, vi } from "vitest";
import {
  createLunaObservability,
  type LunaObservabilityEvent,
  type LunaObservabilitySink
} from "../../src/core/observability/luna-observability.js";

function baseOptions(sinks: LunaObservabilitySink[]) {
  return {
    run: { id: "run-1", flueRunId: "flue-1", attempt: 2 },
    workflow: { id: "code-review" },
    sinks,
    now: () => new Date("2026-06-20T12:00:00.000Z"),
    createEventId: () => "event-fixed"
  };
}

describe("Luna observability", () => {
  it("decorates events with the flat Luna event contract", async () => {
    const events: LunaObservabilityEvent[] = [];
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

    await observability.emit("info", "luna.test.event", {
      step_id: "plan",
      node_type: "agent",
      agent_id: "reviewer",
      subagent_id: "helper",
      prompt_id: "prompt-1",
      status: "completed",
      duration_ms: 12,
      ok: true
    });

    expect(events).toEqual([
      {
        event: "luna.test.event",
        run_id: "run-1",
        workflow_id: "code-review",
        schema_version: 1,
        event_id: "event-fixed",
        sequence: 1,
        timestamp: "2026-06-20T12:00:00.000Z",
        level: "info",
        flue_run_id: "flue-1",
        run_attempt: 2,
        step_id: "plan",
        node_type: "agent",
        agent_id: "reviewer",
        subagent_id: "helper",
        prompt_id: "prompt-1",
        status: "completed",
        duration_ms: 12,
        attributes: { ok: true }
      }
    ]);
    expect(events[0]).not.toHaveProperty("type");
    expect(events[0]).not.toHaveProperty("run");
    expect(events[0]).not.toHaveProperty("workflow");
  });

  it("redacts prompt and provider payload variants and sanitizes circular, bigint, and Error values", async () => {
    const events: LunaObservabilityEvent[] = [];
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

    await observability.emit("info", "luna.prompt.completed", {
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
    });

    expect(events[0]).toMatchObject({
      error: {
        name: "Error",
        message: "Authorization: Bearer [REDACTED]"
      },
      attributes: {
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
    const events: LunaObservabilityEvent[] = [];
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

    await observability.emit("warn", "luna.test.circular-error", {
      error: circularError
    });

    expect(events[0]?.error).toMatchObject({
      name: "Error",
      message: "loop",
      cause: "[Circular]"
    });
    expect(() => JSON.stringify(events[0])).not.toThrow();
  });

  it("serializes concurrent emits and optional sink warnings in required sink order", async () => {
    const releases: Array<() => void> = [];
    const requiredEvents: LunaObservabilityEvent[] = [];
    const observability = createLunaObservability(
      baseOptions([
        {
          id: "optional",
          required: false,
          append: async (event) => {
            if (event.event === "first") {
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

    const first = observability.emit("info", "first");
    const second = observability.emit("info", "second");

    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();

    await Promise.all([first, second]);

    expect(requiredEvents.map((event) => [event.sequence, event.event])).toEqual([
      [1, "first"],
      [2, "luna.observability.sink.warning"],
      [3, "second"]
    ]);
    expect(requiredEvents[1]).toMatchObject({
      level: "warn",
      error: {
        name: "Error",
        message: "network unavailable"
      },
      attributes: {
        sink_id: "optional",
        required: false
      }
    });
  });

  it("serializes concurrent emits so sequence numbers and sink writes stay ordered", async () => {
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
            written.push(event.sequence);
          }
        }
      ])
    );

    const first = observability.emit("info", "first");
    const second = observability.emit("info", "second");

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
      observability.emit("error", "luna.workflow.failed")
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
    await expect(observability.emit("info", "after-failure")).rejects.toBe(
      observability.hardFailure()
    );
  });

  it("close waits for queued events and preserves hard failure state", async () => {
    const events: LunaObservabilityEvent[] = [];
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

    const pending = observability.emit("info", "queued");

    await expect(observability.close()).resolves.toBeUndefined();
    await pending;

    expect(events.map((event) => event.event)).toEqual(["queued"]);
    expect(observability.isHardFailed()).toBe(false);
    expect(observability.hardFailure()).toBeUndefined();
  });

  it("emits optional sink failures as warnings through required sinks when possible", async () => {
    const requiredEvents: LunaObservabilityEvent[] = [];
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

    await observability.emit("info", "luna.test.event", { ok: true });

    expect(requiredEvents.map((event) => event.event)).toEqual([
      "luna.test.event",
      "luna.observability.sink.warning"
    ]);
    expect(requiredEvents[1]).toMatchObject({
      level: "warn",
      sequence: 2,
      error: {
        name: "Error",
        message: "network unavailable"
      },
      attributes: {
        sink_id: "optional",
        required: false
      }
    });
  });
});
