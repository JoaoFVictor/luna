import { StudioAuthoringClient } from "@/api/authoring-client"
import { StudioConfigurationClient } from "@/api/configuration-client"
import {
  StudioApiError,
  StudioHttpClient,
  type StudioHttpClientApi,
} from "@/api/client-core"
import { StudioHistoryClient } from "@/api/history-client"
import { StudioInputRoutingClient } from "@/api/input-routing-client"
import { StudioRunsClient } from "@/api/runs-client"

export { StudioApiError }

type PublicSurface<T> = { [Key in keyof T]: T[Key] }

type StudioApiSurface = StudioHttpClientApi &
  PublicSurface<StudioAuthoringClient> &
  PublicSurface<StudioRunsClient> &
  PublicSurface<StudioInputRoutingClient> &
  PublicSurface<StudioConfigurationClient> &
  PublicSurface<StudioHistoryClient>

function createStudioApiSurface(): StudioApiSurface {
  const http = new StudioHttpClient()
  const request = http.request

  return Object.assign(
    {},
    http,
    new StudioAuthoringClient(request),
    new StudioRunsClient(request),
    new StudioInputRoutingClient(request),
    new StudioConfigurationClient(request),
    new StudioHistoryClient(request),
  )
}

/**
 * The public client is a flat composition of cohesive domain clients. The HTTP
 * core remains the sole owner of session and request state; each domain gets
 * only its bound request capability.
 */
export class StudioApiClient implements StudioApiSurface {
  declare readonly sessionSnapshot: StudioHttpClientApi["sessionSnapshot"]
  declare readonly subscribeSession: StudioHttpClientApi["subscribeSession"]
  declare readonly canMutate: StudioHttpClientApi["canMutate"]
  declare readonly bootstrap: StudioHttpClientApi["bootstrap"]
  declare readonly request: StudioHttpClientApi["request"]

  declare readonly workflows: StudioAuthoringClient["workflows"]
  declare readonly agents: StudioAuthoringClient["agents"]
  declare readonly library: StudioAuthoringClient["library"]
  declare readonly evaluateExpression: StudioAuthoringClient["evaluateExpression"]
  declare readonly validateSchemaInstance: StudioAuthoringClient["validateSchemaInstance"]
  declare readonly drafts: StudioAuthoringClient["drafts"]
  declare readonly draft: StudioAuthoringClient["draft"]
  declare readonly draftTemplates: StudioAuthoringClient["draftTemplates"]
  declare readonly createDraft: StudioAuthoringClient["createDraft"]
  declare readonly patchDraft: StudioAuthoringClient["patchDraft"]
  declare readonly editDraftSource: StudioAuthoringClient["editDraftSource"]
  declare readonly draftSourceView: StudioAuthoringClient["draftSourceView"]
  declare readonly patchDraftLayout: StudioAuthoringClient["patchDraftLayout"]
  declare readonly deleteDraft: StudioAuthoringClient["deleteDraft"]
  declare readonly validateDraft: StudioAuthoringClient["validateDraft"]
  declare readonly compileDraft: StudioAuthoringClient["compileDraft"]
  declare readonly planApply: StudioAuthoringClient["planApply"]
  declare readonly applyDraft: StudioAuthoringClient["applyDraft"]

  declare readonly runs: StudioRunsClient["runs"]
  declare readonly planRun: StudioRunsClient["planRun"]
  declare readonly executeRun: StudioRunsClient["executeRun"]
  declare readonly runCatalogPage: StudioRunsClient["runCatalogPage"]
  declare readonly run: StudioRunsClient["run"]
  declare readonly runGraph: StudioRunsClient["runGraph"]
  declare readonly runTimeline: StudioRunsClient["runTimeline"]
  declare readonly runEventStreamUrl: StudioRunsClient["runEventStreamUrl"]
  declare readonly artifacts: StudioRunsClient["artifacts"]
  declare readonly artifactMetadata: StudioRunsClient["artifactMetadata"]
  declare readonly artifactPreview: StudioRunsClient["artifactPreview"]
  declare readonly artifactDownloadUrl: StudioRunsClient["artifactDownloadUrl"]
  declare readonly runLogs: StudioRunsClient["runLogs"]

  declare readonly inputAdapters: StudioInputRoutingClient["inputAdapters"]
  declare readonly previewInputAdapter: StudioInputRoutingClient["previewInputAdapter"]
  declare readonly previewInputRoute: StudioInputRoutingClient["previewInputRoute"]
  declare readonly simulateRouting: StudioInputRoutingClient["simulateRouting"]
  declare readonly routing: StudioInputRoutingClient["routing"]

  declare readonly workflowConfiguration: StudioConfigurationClient["workflowConfiguration"]
  declare readonly createConfigurationDraft: StudioConfigurationClient["createConfigurationDraft"]
  declare readonly configurationDraft: StudioConfigurationClient["configurationDraft"]
  declare readonly patchConfigurationDraft: StudioConfigurationClient["patchConfigurationDraft"]
  declare readonly validateConfigurationDraft: StudioConfigurationClient["validateConfigurationDraft"]
  declare readonly planConfigurationApply: StudioConfigurationClient["planConfigurationApply"]
  declare readonly applyConfigurationDraft: StudioConfigurationClient["applyConfigurationDraft"]
  declare readonly modelConfiguration: StudioConfigurationClient["modelConfiguration"]
  declare readonly repositoryConfiguration: StudioConfigurationClient["repositoryConfiguration"]
  declare readonly providerConfiguration: StudioConfigurationClient["providerConfiguration"]
  declare readonly runtimeConfiguration: StudioConfigurationClient["runtimeConfiguration"]

  declare readonly resourceHistory: StudioHistoryClient["resourceHistory"]
  declare readonly compareResourceHistory: StudioHistoryClient["compareResourceHistory"]
  declare readonly restoreResourceHistory: StudioHistoryClient["restoreResourceHistory"]

  constructor() {
    Object.assign(this, createStudioApiSurface())
  }
}

export const studioApi = new StudioApiClient()

export function describeStudioError(error: unknown): {
  title: string
  message: string
  requestId?: string
} {
  if (error instanceof StudioApiError) {
    return {
      title:
        error.code === "studio_server_unreachable"
          ? "Servidor local indisponível"
          : "Não foi possível concluir a operação",
      message: error.message,
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    }
  }
  return {
    title: "Erro inesperado",
    message: "O Studio encontrou um erro que não conseguiu classificar.",
  }
}
