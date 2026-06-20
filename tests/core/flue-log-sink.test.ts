import { describe, expect, it, vi } from "vitest";
import { createFlueLogSink } from "../../src/core/observability/flue-log-sink.js";
import type { LunaObservabilityEvent } from "../../src/core/observability/luna-observability.js";

describe("Flue log observability sink", () => {
  it("maps flat event levels to ctx.log methods with luna attributes", async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const sink = createFlueLogSink({ info, warn, error });
    const baseEvent = {
      event: "luna.info",
      run_id: "run-1",
      workflow_id: "code-review",
      schema_version: 1,
      event_id: "event-1",
      sequence: 1,
      timestamp: "2026-06-20T12:00:00.000Z",
      flue_run_id: "flue-1"
    } satisfies Omit<LunaObservabilityEvent, "level">;

    await sink.append({
      ...baseEvent,
      level: "info",
      step_id: "plan",
      attributes: { token: "secret" }
    });
    await sink.append({
      ...baseEvent,
      event: "luna.warn",
      level: "warn",
      attributes: { warning: true }
    });
    await sink.append({
      ...baseEvent,
      event: "luna.error",
      level: "error",
      error: { code: "real_error", message: "boom" }
    });

    expect(info).toHaveBeenCalledWith("luna.info", {
      "luna.schema_version": 1,
      "luna.event_id": "event-1",
      "luna.sequence": 1,
      "luna.timestamp": "2026-06-20T12:00:00.000Z",
      "luna.run_id": "run-1",
      "luna.flue_run_id": "flue-1",
      "luna.workflow_id": "code-review",
      "luna.step_id": "plan",
      token: "[REDACTED]"
    });
    expect(warn).toHaveBeenCalledWith(
      "luna.warn",
      expect.objectContaining({ "luna.event_id": "event-1", warning: true })
    );
    expect(error).toHaveBeenCalledWith(
      "luna.error",
      expect.objectContaining({
        "luna.workflow_id": "code-review",
        "error.code": "real_error",
        "error.message": "boom"
      })
    );
  });

  it("does not let event attributes overwrite reserved luna or error metadata", async () => {
    const info = vi.fn();
    const sink = createFlueLogSink({
      info,
      warn: vi.fn(),
      error: vi.fn()
    });

    await sink.append({
      event: "luna.info",
      run_id: "run-1",
      workflow_id: "code-review",
      schema_version: 1,
      event_id: "event-1",
      sequence: 1,
      timestamp: "2026-06-20T12:00:00.000Z",
      level: "info",
      error: { code: "real_error", message: "real message" },
      attributes: {
        "luna.run_id": "evil-run",
        "luna.workflow_id": "evil-workflow",
        "error.code": "evil-error",
        "error.message": "evil message",
        custom: "kept"
      }
    });

    expect(info).toHaveBeenCalledWith("luna.info", {
      "luna.schema_version": 1,
      "luna.event_id": "event-1",
      "luna.sequence": 1,
      "luna.timestamp": "2026-06-20T12:00:00.000Z",
      "luna.run_id": "run-1",
      "luna.workflow_id": "code-review",
      "error.code": "real_error",
      "error.message": "real message",
      custom: "kept"
    });
  });
});
