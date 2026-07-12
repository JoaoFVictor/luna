import type { RunRecord } from "@/api/types"

type RunFailurePresentation = {
  title: string
  description: string
}

export function runFailurePresentation(
  failure: NonNullable<RunRecord["failure"]>,
  failedNodeId: string | undefined,
  runStatus?: RunRecord["run_status"],
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

  if (
    runStatus === "outcome_unknown" ||
    failure.diagnostics?.certainty === "unknown" ||
    failure.diagnostics?.retryability === "unsafe"
  ) {
    return {
      title: "Resultado externo não confirmado",
      description: "A execução pode ter produzido um efeito, mas o Studio não recebeu confirmação suficiente para afirmar o resultado. Não repita sem revisar o destino e a operação.",
    }
  }

  if (failure.diagnostics?.category === "validation") {
    return {
      title: "Dados inválidos para este passo",
      description: "Revise a entrada e a configuração do passo antes de executar novamente.",
    }
  }

  if (failure.diagnostics?.category === "timeout") {
    return {
      title: "O tempo da execução terminou",
      description: "O Studio não recebeu uma resposta dentro do limite. Confira o destino antes de repetir, pois a operação pode ter continuado fora do Studio.",
    }
  }

  return {
    title: "Não foi possível concluir a execução",
    description: "Revise o passo que falhou e os detalhes técnicos antes de executar novamente.",
  }
}
