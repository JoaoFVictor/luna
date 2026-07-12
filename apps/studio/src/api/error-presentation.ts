import { StudioApiError } from "@/api/client-core"

export type StudioErrorPresentation = {
  title: string
  message: string
  technicalMessage?: string
  code?: string
  requestId?: string
}

const ACTIONABLE_ERRORS: Readonly<Record<string, Pick<StudioErrorPresentation, "title" | "message">>> = {
  studio_run_repository_unavailable: {
    title: "Repositório necessário",
    message: "Informe o repository na entrada ou configure-o em Configurações → Repositórios antes de testar.",
  },
  studio_run_repository_not_ready: {
    title: "Checkout local indisponível",
    message: "O repositório configurado não está acessível ou não é um checkout Git válido. Confira o diagnóstico em Conexões → Segurança técnica → Repositórios locais.",
  },
  studio_run_routing_no_match: {
    title: "Nenhuma regra escolheu um workflow",
    message: "Revise a entrada ou adicione uma regra correspondente em Launchers → Routing.",
  },
  studio_run_target_mismatch: {
    title: "Destino da entrada não confere",
    message: "O workflow indicado pela entrada é diferente do workflow selecionado. Corrija o target ou remova-o.",
  },
  studio_run_plan_stale: {
    title: "O workflow mudou",
    message: "Gere um novo plano para usar a revisão mais recente.",
  },
  studio_run_plan_resolution_invalid: {
    title: "Workflow ainda não executável",
    message: "Valide o workflow e confira agents, configuração e campos obrigatórios destacados no editor.",
  },
  studio_agent_test_model_profile_unavailable: {
    title: "Model profile indisponível",
    message: "Escolha um profile carregado ou configure o profile declarado pelo agent.",
  },
  studio_agent_test_runtime_unavailable: {
    title: "Runtime do agent indisponível",
    message: "Confira a configuração do runtime e do provider do modelo antes de testar novamente.",
  },
  studio_agent_test_output_invalid: {
    title: "Resposta fora do contrato",
    message: "O modelo respondeu, mas o resultado não atende ao output schema do agent. Ajuste o prompt ou o schema.",
  },
  studio_agent_test_runtime_failed: {
    title: "O modelo recusou ou falhou",
    message: "Confira provider, credenciais, model profile e limites do modelo; depois gere um novo preview.",
  },
  studio_agent_test_plan_stale: {
    title: "Preview desatualizado",
    message: "O agent ou sua configuração mudou. Gere um novo preview antes de executar.",
  },
}

export function describeStudioError(error: unknown): StudioErrorPresentation {
  if (error instanceof StudioApiError) {
    const actionable = ACTIONABLE_ERRORS[error.code]
    if (actionable !== undefined) {
      return {
        ...actionable,
        technicalMessage: error.message,
        code: error.code,
        ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      }
    }
    if (error.status === 404) {
      return {
        title: "Recurso não encontrado",
        message: "Ele pode ter sido removido ou não estar disponível nesta sessão. Volte à lista e escolha outro item.",
        technicalMessage: error.message,
        code: error.code,
        ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      }
    }
    if (error.status === 400) {
      return {
        title: "Revise os dados informados",
        message: "Um ou mais campos não foram aceitos. Confira a entrada e tente novamente.",
        technicalMessage: error.message,
        code: error.code,
        ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      }
    }
    return {
      title: error.code === "studio_server_unreachable"
        ? "Servidor local indisponível"
        : "Não foi possível concluir a operação",
      message: error.code === "studio_server_unreachable"
        ? "Inicie o Luna Studio e tente novamente."
        : "A operação falhou. Tente novamente ou abra os detalhes técnicos para investigar.",
      technicalMessage: error.message,
      code: error.code,
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    }
  }
  return {
    title: "Erro inesperado",
    message: error instanceof Error
      ? error.message
      : "O Studio encontrou um erro que não conseguiu classificar.",
  }
}
