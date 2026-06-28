import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../../src/core/runtime/json.js";
import {
  cancelNode,
  failNode,
  markNodeWaitingForInput,
  startNodeAttempt,
  succeedNode,
  timeOutNode,
  waitForRetry
} from "../../../src/core/runtime/lifecycle.js";
import { createInitialRuntimeState } from "../../../src/core/runtime/state.js";

const invocation = {
  version: "2026-06",
  source: "github",
  event: "pull_request",
  target: { type: "workflow", id: "code-review" }
} satisfies JsonValue;

const config = {
  repository_id: "luna"
} satisfies JsonValue;

const run = {
  run_id: "run-1",
  workflow_id: "code-review",
  attempt: 1,
  started_at: "2026-06-25T12:00:00.000Z"
};

const workflow = {
  id: "code-review",
  mode: "read_only"
} as const;

function initialState() {
  return createInitialRuntimeState({
    invocation,
    config,
    run,
    workflow
  });
}

describe("runtime lifecycle", () => {
  it("records immutable attempt history across retry and success", () => {
    const firstAttempt = startNodeAttempt(initialState(), "review", 1);
    const failed = failNode(firstAttempt, "review", "err-1");
    const waiting = waitForRetry(failed, "review");
    const secondAttempt = startNodeAttempt(waiting, "review", 2, {
      retryPermitted: true
    });
    const succeeded = succeedNode(secondAttempt, "review");

    expect(waiting.run_status).toBe("waiting_for_retry");
    expect(succeeded.node_statuses.review.status).toBe("succeeded");
    expect(succeeded.attempts.review).toMatchObject({
      count: 2,
      history: [
        { attempt: 1, status: "failed", error_ref: "err-1" },
        { attempt: 2, status: "succeeded" }
      ]
    });
    expect(firstAttempt.attempts.review).toEqual({
      count: 1,
      history: [
        expect.objectContaining({
          attempt: 1,
          status: "started"
        })
      ]
    });
  });

  it("rejects retry attempts unless the caller supplies a retry contract", () => {
    const waiting = waitForRetry(
      failNode(startNodeAttempt(initialState(), "review", 1), "review"),
      "review"
    );

    expect(() => startNodeAttempt(waiting, "review", 2)).toThrow(
      expect.objectContaining({ code: "runtime_retry_not_permitted" })
    );
    expect(() =>
      startNodeAttempt(
        startNodeAttempt(initialState(), "review", 1),
        "review",
        1
      )
    ).toThrow(expect.objectContaining({ code: "runtime_node_attempt_invalid" }));
    expect(() =>
      startNodeAttempt(waiting, "review", 3, { retryPermitted: true })
    ).toThrow(expect.objectContaining({ code: "runtime_node_attempt_invalid" }));
  });

  it("records timeout and cancellation as terminal attempts", () => {
    const timedOut = timeOutNode(
      startNodeAttempt(initialState(), "review", 1),
      "review",
      "timeout-1"
    );
    const cancelled = cancelNode(
      startNodeAttempt(initialState(), "implementation", 1),
      "implementation"
    );

    expect(timedOut.node_statuses.review.status).toBe("timed_out");
    expect(timedOut.primary_failure).toEqual({
      node_id: "review",
      status: "timed_out",
      error_ref: "timeout-1"
    });
    expect(timedOut.attempts.review.history[0]).toMatchObject({
      attempt: 1,
      status: "timed_out",
      error_ref: "timeout-1"
    });
    expect(cancelled.run_status).toBe("cancelled");
    expect(cancelled.node_statuses.implementation.status).toBe("cancelled");
    expect(cancelled.attempts.implementation.history[0]).toMatchObject({
      attempt: 1,
      status: "cancelled"
    });
    expect(cancelled.primary_failure).toBeUndefined();
  });

  it("preserves the primary failing node when later nodes also fail", () => {
    const firstFailed = failNode(
      startNodeAttempt(initialState(), "review", 1),
      "review",
      "err-review"
    );
    const secondFailed = failNode(
      startNodeAttempt(firstFailed, "report", 1),
      "report",
      "err-report"
    );

    expect(secondFailed.primary_failure).toEqual({
      node_id: "review",
      status: "failed",
      error_ref: "err-review"
    });
  });

  it("cancels a workflow waiting for human input", () => {
    const waiting = markNodeWaitingForInput(
      startNodeAttempt(initialState(), "approval", 1),
      "approval"
    );
    const cancelled = cancelNode(waiting, "approval");

    expect(waiting.run_status).toBe("waiting_for_input");
    expect(waiting.node_statuses.approval.status).toBe("waiting_for_input");
    expect(cancelled.run_status).toBe("cancelled");
    expect(cancelled.node_statuses.approval.status).toBe("cancelled");
    expect(cancelled.attempts.approval.history[0]).toMatchObject({
      attempt: 1,
      status: "cancelled"
    });
  });
});
