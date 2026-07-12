import { StudioApiError } from "@/api/client"
import { describeStudioError } from "@/api/error-presentation"

export type RunLaunchNotice = {
  kind: "error" | "replan" | "acceptance_unknown" | "blocked"
  title: string
  message: string
  requestId?: string
  planId?: string
  code?: string
  technicalMessage?: string
}

export function newRunIdempotencyKey(planId: string): string {
  return `studio:${planId}:${crypto.randomUUID()}`
}

export function runLaunchNotice(
  error: unknown,
  operation: "plan" | "execute",
  planId?: string,
): RunLaunchNotice {
  if (!(error instanceof StudioApiError)) {
    return {
      kind: operation === "execute" ? "acceptance_unknown" : "error",
      title:
        operation === "execute"
          ? "Aceite da execução é desconhecido"
          : "Não foi possível criar o plano",
      message:
        operation === "execute"
          ? "A conexão terminou sem uma resposta canônica. Consulte Runs antes de tentar qualquer nova execução."
          : "O Studio encontrou um erro não classificado ao criar o plano.",
      ...(planId === undefined ? {} : { planId }),
    }
  }

  if (error.code === "studio_run_interrupt_resume_unsupported") {
    return {
      kind: "blocked",
      title: "Workflow interruptível bloqueado",
      message:
        "A DAG pode pausar aguardando uma decisão, mas o Studio ainda não oferece uma retomada local segura. Nenhum run foi criado.",
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    }
  }

  if (error.code.startsWith("studio_run_test_data_")) {
    return {
      kind: error.code === "studio_run_test_data_stale" ? "replan" : "blocked",
      title: error.code === "studio_run_test_data_stale"
        ? "Dados de teste desatualizados"
        : "Dados de teste não utilizáveis",
      message: error.code === "studio_run_test_data_unavailable"
        ? "A saída original não está mais disponível para autorizar esta substituição. Capture novos dados em uma execução."
        : error.code === "studio_run_test_data_stale"
          ? "O workflow ou a origem mudou. Selecione dados compatíveis com a revisão atual e crie outro plano."
          : "Estes dados continuam disponíveis para preview, mas não atendem ao contrato seguro de execução manual.",
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      code: error.code,
    }
  }

  if (
    error.code === "studio_run_plan_stale" ||
    error.code === "studio_run_confirmation_invalid"
  ) {
    return {
      kind: "replan",
      title: "Crie um novo plano",
      message:
        error.code === "studio_run_plan_stale"
          ? "Workflow, configuração, catálogo, repository ou efeitos mudaram depois do plano."
          : "A confirmação expirou, já foi consumida ou não pertence mais a esta sessão.",
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    }
  }

  if (
    operation === "execute" &&
    (error.status === 0 ||
      error.status >= 500 ||
      error.code === "studio_response_invalid" ||
      error.details.acceptance_unknown === true)
  ) {
    return {
      kind: "acceptance_unknown",
      title: "Aceite da execução é desconhecido",
      message:
        "O servidor não confirmou nem negou o aceite. Consulte Runs usando o plano exibido antes de repetir a operação.",
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      ...(planId === undefined ? {} : { planId }),
    }
  }

  const described = describeStudioError(error)
  return {
    kind: "error",
    title: operation === "execute" && described.title === "Não foi possível concluir a operação"
      ? "A execução não foi aceita"
      : described.title,
    message: described.message,
    ...(described.code === undefined ? {} : { code: described.code }),
    ...(described.technicalMessage === undefined
      ? {}
      : { technicalMessage: described.technicalMessage }),
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
  }
}
