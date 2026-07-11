import { describe, expect, it } from "vitest";
import { studioRunLaunchError } from "../../../src/studio/application/runs/launch-errors.js";
import { studioRunLaunchHttpError } from "../../../src/studio/server/run-launch-errors.js";

describe("Studio run launch public errors", () => {
  it("publishes a bounded interrupt-resume diagnostic without internal details", () => {
    const mapped = studioRunLaunchHttpError(studioRunLaunchError(
      "studio_run_interrupt_resume_unsupported",
      "internal diagnostic that must not cross the API",
      {
        workflow_id: "review",
        mode: "trusted_local_write",
        interruptible_node_count: 2,
        secret_path: "/private/project/workflows/review/workflow.yaml"
      }
    ));

    expect(mapped).toEqual({
      statusCode: 409,
      code: "studio_run_interrupt_resume_unsupported",
      message: "This workflow can pause for input, but local resume is not available in Studio yet",
      details: {
        resume_available: false,
        can_create_pending_interrupt: true,
        workflow_id: "review",
        mode: "trusted_local_write",
        interruptible_node_count: 2
      }
    });
    expect(JSON.stringify(mapped)).not.toContain("private/project");
  });

  it("does not echo launch credentials or private execution input in errors", () => {
    const mapped = studioRunLaunchHttpError(studioRunLaunchError(
      "studio_run_dispatch_failed",
      "private cause",
      {
        acceptance_unknown: true,
        plan_id: `rp_${"p".repeat(32)}`,
        confirmation_token: "private-confirmation-token",
        idempotency_key: "private-idempotency-key",
        invocation: "private-invocation",
        config: "private-config"
      }
    ));

    expect(mapped?.details).toEqual({
      acceptance_unknown: true,
      plan_id: `rp_${"p".repeat(32)}`
    });
    expect(JSON.stringify(mapped)).not.toContain("private-");
  });
});
