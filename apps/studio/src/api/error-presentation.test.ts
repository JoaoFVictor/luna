import { describe, expect, it } from "vitest"

import { StudioApiError } from "@/api/client-core"
import { describeStudioError } from "@/api/error-presentation"

describe("describeStudioError", () => {
  it("keeps invalid request details technical and gives an actionable message", () => {
    const result = describeStudioError(new StudioApiError({
      status: 400,
      code: "studio_request_invalid",
      message: "The Studio request body is invalid",
    }))

    expect(result).toMatchObject({
      title: "Revise os dados informados",
      message: "Um ou mais campos não foram aceitos. Confira a entrada e tente novamente.",
      technicalMessage: "The Studio request body is invalid",
    })
  })

  it("does not expose an unknown server message as primary guidance", () => {
    const result = describeStudioError(new StudioApiError({
      status: 500,
      code: "studio_internal_error",
      message: "Internal implementation detail",
    }))

    expect(result.message).not.toContain("Internal implementation detail")
    expect(result.technicalMessage).toBe("Internal implementation detail")
  })

  it("directs a repository checkout failure to connections", () => {
    expect(describeStudioError(new StudioApiError({
      status: 409,
      code: "studio_run_repository_not_ready",
      message: "The configured repository checkout is not ready for execution",
      details: { repository_id: "example-repo" },
    }))).toMatchObject({
      title: "Checkout local indisponível",
      message: expect.stringContaining("Conexões → Segurança técnica"),
      code: "studio_run_repository_not_ready",
    })
  })

  it("explains when Git history is not a capability of the checkout", () => {
    expect(describeStudioError(new StudioApiError({
      status: 409,
      code: "studio_history_unavailable",
      message: "Git history requires an attached branch",
    }))).toMatchObject({
      title: "Histórico Git indisponível",
      message: expect.stringContaining("branch Git anexado"),
      technicalMessage: "Git history requires an attached branch",
    })
  })

  it("explains that a run pinned to an older capability catalog must be restarted", () => {
    expect(describeStudioError(new StudioApiError({
      status: 409,
      code: "studio_run_resume_catalog_changed",
      message: "The run cannot be resumed because the runtime capability catalog changed",
    }))).toMatchObject({
      title: "A execução usa outra versão do runtime",
      message: expect.stringContaining("inicie uma nova execução"),
      code: "studio_run_resume_catalog_changed",
    })
  })
})
