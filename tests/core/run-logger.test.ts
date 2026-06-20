import { describe, expect, it, vi } from "vitest";
import { createFlueRunLogger, noopRunLogger } from "../../src/core/run-logger.js";

describe("run logger", () => {
  it("no-op logger accepts structured events", () => {
    expect(() =>
      noopRunLogger.info("luna.run.succeeded", { token: "secret" })
    ).not.toThrow();
  });

  it("redacts structured attributes before writing through Flue ctx.log", () => {
    const info = vi.fn();
    const logger = createFlueRunLogger({
      log: { info, warn: vi.fn(), error: vi.fn() }
    });

    logger.info("luna.scheduler.step_started", {
      "luna.run_id": "run-1",
      token: "secret-value"
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(info.mock.calls[0])).not.toContain("secret-value");
  });

  it("emits required event names with stable Luna attributes", () => {
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const logger = createFlueRunLogger({ log: { info, warn, error } });

    logger.info("luna.scheduler.step_started", {
      "luna.run_id": "run-1",
      "luna.flue_run_id": "flue-1",
      "luna.workflow_id": "code-review",
      "luna.step_id": "preflight"
    });
    logger.warn("luna.lock.waiting", {
      "luna.run_id": "run-1",
      "luna.resource": "repository:repo"
    });
    logger.error("luna.run.failed", {
      "luna.run_id": "run-1",
      "error.code": "scheduler_step_failed"
    });
    logger.info("luna.workspace.cleaned", {
      "luna.run_id": "run-1",
      "luna.workflow_id": "code-review",
      duration_ms: 12
    });
    logger.warn("luna.branch.retry", {
      "luna.run_id": "run-1",
      "luna.resource": "repository:repo",
      duration_ms: 3
    });
    logger.error("luna.lock.timeout", {
      "luna.run_id": "run-1",
      "luna.resource": "repository:repo",
      "error.code": "lock_timeout",
      duration_ms: 120000
    });

    expect(info).toHaveBeenCalledWith(
      "luna.scheduler.step_started",
      expect.objectContaining({
        "luna.run_id": "run-1",
        "luna.workflow_id": "code-review",
        "luna.step_id": "preflight"
      })
    );
    expect(warn).toHaveBeenCalledWith(
      "luna.lock.waiting",
      expect.objectContaining({ "luna.resource": "repository:repo" })
    );
    expect(error).toHaveBeenCalledWith(
      "luna.run.failed",
      expect.objectContaining({ "error.code": "scheduler_step_failed" })
    );
    expect(info).toHaveBeenCalledWith(
      "luna.workspace.cleaned",
      expect.objectContaining({ duration_ms: 12 })
    );
    expect(warn).toHaveBeenCalledWith(
      "luna.branch.retry",
      expect.objectContaining({ "luna.resource": "repository:repo" })
    );
    expect(error).toHaveBeenCalledWith(
      "luna.lock.timeout",
      expect.objectContaining({
        "error.code": "lock_timeout",
        duration_ms: 120000
      })
    );
  });
});
