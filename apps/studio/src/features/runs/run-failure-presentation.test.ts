import { describe, expect, it } from "vitest"

import { runFailurePresentation } from "@/features/runs/run-failure-presentation"

describe("runFailurePresentation", () => {
  it("explains the missing repository needed by context collection", () => {
    expect(runFailurePresentation(
      { code: "built_in_state_missing", message: "Native workflow execution failed" },
      "collect_context",
    )).toEqual({
      title: "Falta informar o repositório",
      description: "O passo de coleta de contexto precisa de um repositório na entrada. Execute novamente e informe uma entrada que identifique o repositório.",
    })
  })

  it("keeps an unknown runtime failure actionable without exposing raw English", () => {
    expect(runFailurePresentation(
      { code: "runtime_node_failed", message: "Native workflow execution failed" },
      "review",
    )).toEqual({
      title: "Não foi possível concluir a execução",
      description: "Revise o passo que falhou e os detalhes técnicos antes de executar novamente.",
    })
  })
})
