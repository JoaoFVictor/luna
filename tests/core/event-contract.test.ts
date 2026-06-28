import { describe, expect, it } from "vitest";
import {
  createLunaObservability,
  runStartedEvent,
  type LunaEvent
} from "../../src/core/observability/luna-observability.js";

const run = { id: "run-1", runtimeRunId: "runtime-1", attempt: 2 };
const workflow = { id: "code-review" };
const timestamp = "2026-06-20T12:00:00.000Z";

function expectCoreEventShape(event: LunaEvent): void {
  expect(event).toMatchObject({
    timestamp,
    run,
    workflow
  });
  expect(event).not.toHaveProperty("event");
  expect(event).not.toHaveProperty("run_id");
  expect(event).not.toHaveProperty("workflow_id");
  expect(event).not.toHaveProperty("attributes");
  expect(event.run).not.toHaveProperty("adapterRunId");
}

describe("luna event contract", () => {
  it("constructs normalized Luna events without runtime-specific aliases", () => {
    const event = runStartedEvent({
      severity: "info",
      run,
      workflow,
      timestamp,
      data: { ok: true }
    });

    expect(event.type).toBe("luna.run.started");
    expect(event.outcome?.status).toBe("started");
    expectCoreEventShape(event);
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
        data: { nested: { circular } } as never
      })
    ).toThrow("Invalid JSON value");
  });

  it("does not promote runtime-specific aliases into generic event run ids", async () => {
    const runtimeShapedRun = {
      id: "run-runtime-shaped",
      adapterRunId: "adapter-specific",
      attempt: 3
    } as unknown as LunaEvent["run"];
    const constructed = runStartedEvent({
      severity: "info",
      run: runtimeShapedRun,
      workflow,
      timestamp
    });
    const emitted: LunaEvent[] = [];
    const observability = createLunaObservability({
      run: runtimeShapedRun,
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
      expect(event.run).toEqual({ id: "run-runtime-shaped", attempt: 3 });
    }
  });

});
