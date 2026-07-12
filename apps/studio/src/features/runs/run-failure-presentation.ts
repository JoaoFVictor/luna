import type { RunRecord } from "@/api/types"

type RunFailurePresentation = {
  title: string
  description: string
}

export function runFailurePresentation(
  failure: NonNullable<RunRecord["failure"]>,
  failedNodeId: string | undefined,
): RunFailurePresentation {
  if (failure.code === "built_in_state_missing") {
    if (failedNodeId === "collect_context") {
      return {
        title: "Falta informar o repositório",
        description: "O passo de coleta de contexto precisa de um repositório na entrada. Execute novamente e informe uma entrada que identifique o repositório.",
      }
    }
    return {
      title: "Faltam dados para executar este passo",
      description: "A entrada não contém todos os dados exigidos pelo passo. Revise a entrada e execute novamente.",
    }
  }

  return {
    title: "Não foi possível concluir a execução",
    description: "Revise o passo que falhou e os detalhes técnicos antes de executar novamente.",
  }
}
