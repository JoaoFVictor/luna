import { describe, expect, it } from "vitest"

import { StudioApiError } from "@/api/client"
import { runLaunchNotice } from "@/features/launch/run-launch-state"

describe("runLaunchNotice", () => {
  it.each([
    [0, "studio_server_unreachable"],
    [202, "studio_response_invalid"],
    [503, "studio_request_failed"],
  ] as const)(
    "treats execute status %s / %s as unknown acceptance",
    (status, code) => {
      expect(runLaunchNotice(new StudioApiError({
        status,
        code,
        message: "No canonical acceptance receipt",
      }), "execute").kind).toBe("acceptance_unknown")
    },
  )

  it("does not turn a plan failure into an acceptance warning", () => {
    expect(runLaunchNotice(new StudioApiError({
      status: 503,
      code: "studio_request_failed",
      message: "Planning failed",
    }), "plan").kind).toBe("error")
  })

  it("keeps definitive execute conflicts distinct from unknown acceptance", () => {
    expect(runLaunchNotice(new StudioApiError({
      status: 409,
      code: "run_idempotency_conflict",
      message: "Definitive conflict",
    }), "execute").kind).toBe("error")
  })
})
