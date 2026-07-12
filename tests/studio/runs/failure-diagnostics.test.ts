import { describe, expect, it } from "vitest";
import {
  failureDiagnosticsFrom
} from "../../../src/studio/application/runs/failure-diagnostics.js";
import {
  RunFailureSchema
} from "../../../src/studio/contracts/runs.js";

describe("run failure diagnostics", () => {
  it("projects safe, provider-neutral metadata from nested transport errors", () => {
    const cause = Object.assign(
      new Error("request failed with token=secret-value"),
      {
        code: "provider_transport_failed",
        details: {
          stderr: "HTTP 422 Unprocessable Entity",
          cause: {
            code: "transport_result_unknown",
        message: "Authorization: Bearer opaque-secret-value"
          }
        }
      }
    );

    expect(failureDiagnosticsFrom({
      cause,
      code: "operation_outcome_unknown",
      certainty: "unknown"
    })).toEqual({
      category: "external",
      retryability: "unsafe",
      status_code: 422,
      cause: {
        code: "transport_result_unknown",
        message: "Authorization: Bearer [redacted]"
      },
      certainty: "unknown"
    });
  });

  it("keeps ordinary validation failures retryable only after correction", () => {
    expect(failureDiagnosticsFrom({
      cause: Object.assign(new Error("Input is invalid"), {
        code: "workflow_input_invalid",
        operation_id: "workflow.validate"
      }),
      code: "workflow_input_invalid"
    })).toEqual({
      category: "validation",
      retryability: "conditional",
      operation_id: "workflow.validate",
      cause: {
        code: "workflow_input_invalid",
        message: "Input is invalid"
      },
      certainty: "known"
    });
  });

  it("accepts legacy failures and the optional diagnostics extension", () => {
    expect(RunFailureSchema.safeParse({
      code: "legacy_failure",
      message: "Legacy run failure"
    }).success).toBe(true);
    expect(RunFailureSchema.safeParse({
      code: "operation_outcome_unknown",
      message: "Outcome is unknown",
      diagnostics: {
        category: "external",
        retryability: "unsafe",
        certainty: "unknown"
      }
    }).success).toBe(true);
  });

  it("does not make invalid diagnostic shapes enter the run contract", () => {
    expect(RunFailureSchema.safeParse({
      code: "bad_failure",
      message: "Invalid status",
      diagnostics: { status_code: 999 }
    }).success).toBe(false);
  });

  it("rejects arbitrary exception payloads at the contract boundary", () => {
    expect(RunFailureSchema.safeParse({
      code: "bad_failure",
      message: "Invalid payload",
      details: { stderr: "should not be persisted" }
    }).success).toBe(false);
  });
});
