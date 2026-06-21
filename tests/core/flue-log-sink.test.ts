import { describe, expect, it, vi } from "vitest";
import { createFlueLogSink } from "../../src/core/agent-runtime/flue/observability.js";
import type { LunaEvent } from "../../src/core/observability/luna-observability.js";

const baseEvent = {
  type: "luna.info",
  severity: "info",
  timestamp: "2026-06-20T12:00:00.000Z",
  run: { id: "run-1", flueRunId: "flue-1", attempt: 2 },
  workflow: { id: "code-review" }
} satisfies Omit<LunaEvent, "outcome" | "step" | "data">;

describe("Flue log observability sink", () => {
  it("maps normalized events to ctx.log methods with luna attributes", async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const sink = createFlueLogSink({ info, warn, error });

    await sink.append({
      ...baseEvent,
      step: { id: "plan", type: "agent" },
      outcome: { status: "succeeded" },
      data: { token: "secret" }
    });
    await sink.append({
      ...baseEvent,
      severity: "warn",
      type: "luna.warning",
      outcome: { status: "skipped" },
      data: { warning: true }
    });
    await sink.append({
      ...baseEvent,
      severity: "error",
      type: "luna.error",
      outcome: { status: "failed", code: "real_error" },
      data: { error: { code: "real_error", message: "boom" } }
    });

    expect(info).toHaveBeenCalledWith("luna.info", {
      "luna.timestamp": "2026-06-20T12:00:00.000Z",
      "luna.run_id": "run-1",
      "luna.flue_run_id": "flue-1",
      "luna.run_attempt": 2,
      "luna.workflow_id": "code-review",
      "luna.step_id": "plan",
      "luna.step_type": "agent",
      "luna.outcome_status": "succeeded",
      token: "[REDACTED]"
    });
    expect(warn).toHaveBeenCalledWith(
      "luna.warning",
      expect.objectContaining({
        "luna.outcome_status": "skipped",
        warning: true
      })
    );
    expect(error).toHaveBeenCalledWith(
      "luna.error",
      expect.objectContaining({
        "luna.workflow_id": "code-review",
        "luna.outcome_status": "failed",
        "luna.outcome_code": "real_error",
        "error.code": "real_error",
        "error.message": "boom"
      })
    );
  });

  it("does not let event data overwrite reserved luna or error metadata", async () => {
    const info = vi.fn();
    const sink = createFlueLogSink({
      info,
      warn: vi.fn(),
      error: vi.fn()
    });

    await sink.append({
      ...baseEvent,
      data: {
        "luna.run_id": "evil-run",
        "luna.workflow_id": "evil-workflow",
        "error.code": "evil-error",
        "error.message": "evil message",
        error: { code: "real_error", message: "real message" },
        custom: "kept"
      }
    });

    expect(info).toHaveBeenCalledWith("luna.info", {
      "luna.timestamp": "2026-06-20T12:00:00.000Z",
      "luna.run_id": "run-1",
      "luna.flue_run_id": "flue-1",
      "luna.run_attempt": 2,
      "luna.workflow_id": "code-review",
      "error.code": "real_error",
      "error.message": "real message",
      error: { code: "real_error", message: "real message" },
      custom: "kept"
    });
  });
});
