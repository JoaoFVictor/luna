import { StudioApiError } from "@/api/client"

export type RunLaunchNotice = {
  kind: "error" | "replan" | "acceptance_unknown" | "blocked"
  title: string
  message: string
  requestId?: string
  planId?: string
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

  return {
    kind: "error",
    title:
      operation === "execute"
        ? "A execução não foi aceita"
        : "Não foi possível criar o plano",
    message: error.message,
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
  }
}
