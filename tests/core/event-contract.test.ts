import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactStore } from "../../src/core/artifacts/store.js";
import type { JsonValue } from "../../src/core/json/value.js";
import {
  createLunaObservability,
  runCompletedEvent,
  runStartedEvent,
  stepFailedEvent,
  stepStartedEvent,
  stepSucceededEvent,
  type LunaEvent,
  type LunaObservabilitySink
} from "../../src/core/observability/luna-observability.js";
import { createJsonlEventSink } from "../../src/core/observability/jsonl-sink.js";

type JsonObject = { [key: string]: JsonValue };

type ExpectedLunaEvent = {
  type: string;
  severity: "info" | "warn" | "error";
  timestamp: string;
  run: {
    id: string;
    runtimeRunId?: string;
    attempt: number;
  };
  workflow: {
    id: string;
  };
  step?: {
    id: string;
    type: "built_in" | "agent" | "gated_agent_loop";
  };
  outcome?: {
    status: "started" | "succeeded" | "failed" | "skipped";
    code?: string;
  };
  data?: JsonObject;
};

const runtimeFiles = [
  "src/runtime/langgraph/workflow-runner.ts",
  "src/core/workflow/runner-locks.ts",
  "src/core/workflow/lock-manager.ts",
  "src/workflows/luna.ts"
];

const run = { id: "run-1", runtimeRunId: "runtime-1", attempt: 2 };
const workflow = { id: "code-review" };
const timestamp = "2026-06-20T12:00:00.000Z";

function expectNormalizedEvent(event: LunaEvent): ExpectedLunaEvent {
  expect(event).toEqual({
    type: expect.any(String),
    severity: expect.stringMatching(/^(info|warn|error)$/),
    timestamp,
    run,
    workflow,
    ...(event.step === undefined
      ? {}
      : {
          step: {
            id: expect.any(String),
            type: expect.stringMatching(/^(built_in|agent|gated_agent_loop)$/)
          }
        }),
    ...(event.outcome === undefined
      ? {}
      : {
          outcome: {
            status: expect.stringMatching(/^(started|succeeded|failed|skipped)$/),
            ...(event.outcome.code === undefined
              ? {}
              : { code: expect.any(String) })
          }
        }),
    ...(event.data === undefined ? {} : { data: expect.any(Object) })
  });

  expect(event).not.toHaveProperty("event");
  expect(event).not.toHaveProperty("run_id");
  expect(event).not.toHaveProperty("workflow_id");
  expect(event).not.toHaveProperty("attributes");
  expect(event.run).not.toHaveProperty("flueRunId");
  return event;
}

describe("luna event contract", () => {
  it("constructs normalized Luna events only", () => {
    const events = [
      runStartedEvent({
        severity: "info",
        run,
        workflow,
        timestamp,
        data: { ok: true }
      }),
      stepStartedEvent({
        severity: "info",
        run,
        workflow,
        timestamp,
        step: { id: "plan", type: "agent" },
        data: { agent_id: "reviewer" }
      }),
      stepSucceededEvent({
        severity: "info",
        run,
        workflow,
        timestamp,
        step: { id: "plan", type: "agent" },
        data: { duration_ms: 12 }
      }),
      stepFailedEvent({
        severity: "error",
        run,
        workflow,
        timestamp,
        step: { id: "plan", type: "agent" },
        code: "agent_failed",
        data: { error: { message: "boom" } }
      }),
      runCompletedEvent({
        severity: "info",
        run,
        workflow,
        timestamp,
        status: "succeeded",
        data: { duration_ms: 20 }
      })
    ];

    expect(events.map((event) => event.type)).toEqual([
      "luna.run.started",
      "luna.step.started",
      "luna.step.succeeded",
      "luna.step.failed",
      "luna.run.completed"
    ]);
    for (const event of events) {
      expectNormalizedEvent(event);
      expect(() => JSON.stringify(event)).not.toThrow();
    }
  });

  it("rejects non-JSON-safe event data recursively", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() =>
      runStartedEvent({
        severity: "info",
        run,
        workflow,
        timestamp,
        data: { nested: { circular } } as JsonObject
      })
    ).toThrow("Invalid JSON value");
  });

  it("does not promote stale Flue run aliases into generic event run ids", async () => {
    const staleRun = {
      id: "run-stale",
      flueRunId: "flue-stale",
      attempt: 3
    } as unknown as LunaEvent["run"];
    const constructed = runStartedEvent({
      severity: "info",
      run: staleRun,
      workflow,
      timestamp
    });
    const emitted: LunaEvent[] = [];
    const observability = createLunaObservability({
      run: staleRun,
      workflow,
      sinks: [
        {
          id: "memory",
          append: (event) => {
            emitted.push(event);
          }
        }
      ],
      now: () => new Date(timestamp)
    });

    await observability.emit(
      runStartedEvent({
        ...observability.eventContext("info")
      })
    );

    for (const event of [constructed, emitted[0]]) {
      expect(event.run).toEqual({ id: "run-stale", attempt: 3 });
      expect(event.run).not.toHaveProperty("runtimeRunId");
    }
  });

  it("fans out the same normalized event shape to JSONL and summary sinks", async () => {
    const jsonlLines: JsonValue[] = [];
    const artifactStore = {
      touchArtifact: vi.fn(async () => undefined),
      appendLine: vi.fn(async (_path: string, value: JsonValue) => {
        jsonlLines.push(value);
      })
    };
    const summaryEvents: LunaEvent[] = [];
    const summarySink: LunaObservabilitySink = {
      id: "summary",
      append: (event) => {
        summaryEvents.push(event);
      }
    };
    const memoryEvents: LunaEvent[] = [];
    const observability = createLunaObservability({
      run,
      workflow,
      sinks: [
        {
          id: "memory",
          append: (event) => {
            memoryEvents.push(event);
          }
        },
        await createJsonlEventSink(artifactStore as unknown as ArtifactStore),
        summarySink
      ],
      now: () => new Date(timestamp)
    });

    await observability.emit(
      stepSucceededEvent({
        ...observability.eventContext("info"),
        step: { id: "plan", type: "agent" },
        data: { duration_ms: 12, usage_missing: true }
      })
    );

    const event = expectNormalizedEvent(memoryEvents[0]);
    expect(jsonlLines[0]).toEqual(event);
    expect(summaryEvents[0]).toEqual(event);
  });

  it("does not emit old underscore-style scheduler, run, or lock event names", async () => {
    const combined = (
      await Promise.all(runtimeFiles.map((file) => readFile(file, "utf8")))
    ).join("\n");

    expect(combined).not.toContain("luna.scheduler.step_started");
    expect(combined).not.toContain("luna.scheduler.step_finished");
    expect(combined).not.toContain("luna.scheduler.step_failed");
    expect(combined).not.toContain("luna.run.succeeded");
    expect(combined).not.toContain("luna.run.failed");
    expect(combined).not.toContain("luna.lock.heartbeat_failed");
  });
});
