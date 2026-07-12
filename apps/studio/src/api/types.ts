import type { JsonValue as CoreJsonValue } from "../../../../src/core/json/value.js"
import type { RouterDefinition as CoreRouterDefinition } from "../../../../src/core/router/router-definition.js"
import type {
  StudioApplyConflict,
  StudioApplyFileDiff,
  StudioApplyPlanResponse,
  StudioApplyResult,
} from "../../../../src/studio/contracts/apply.js"
import type {
  StudioAgentCatalog,
  StudioAgentCatalogItem,
  StudioCatalogDiagnostic,
} from "../../../../src/studio/contracts/catalog.js"
import type {
  StudioCapabilityCatalog,
  StudioCapabilityRegistration,
  StudioCapabilitySummary,
  StudioRegistrationPresentation,
} from "../../../../src/studio/contracts/capability-catalog.js"
import type {
  StudioHttpErrorEnvelope,
  StudioSessionStateResponse,
} from "../../../../src/studio/contracts/control-api.js"
import type {
  StudioDraftAuthoringListPage,
  StudioDraftCreateRequest,
  StudioDraftFile,
  StudioDraftItem,
  StudioDraftListItem,
  StudioDraftValidationResponse,
  StudioDraftSourceView,
  StudioDraftTemplateCatalog,
  StudioDraftTemplateSelection,
  StudioYamlSourceOperation,
} from "../../../../src/studio/contracts/draft-authoring.js"
import type {
  StudioAdapterPreview,
  StudioAdapterRoutingPreview,
  StudioInputAdapterCatalog,
  StudioInputAdapterSummary,
  StudioPublicInvocation,
  StudioRoutingDiagnostic,
  StudioRoutingEditor,
  StudioRoutingSaveRequest,
  StudioRoutingSaveResult,
  StudioRoutingSimulation,
} from "../../../../src/studio/contracts/input-routing.js"
import type {
  StudioExpressionEvaluation,
  StudioExpressionEvaluationRequest,
} from "../../../../src/studio/contracts/expression-evaluation.js"
import type {
  StudioSchemaValidation,
  StudioSchemaValidationRequest,
} from "../../../../src/studio/contracts/schema-validation.js"
import type {
  StudioPath as ContractStudioPath,
  StudioResourceRef,
} from "../../../../src/studio/contracts/paths.js"
import type {
  RunCatalogItem as ContractRunCatalogItem,
  RunCatalogPage as ContractRunCatalogPage,
  RunCatalogSummary,
  RunDisplayStatus,
  RunEvent as ContractRunEvent,
  RunEventPage as ContractRunEventPage,
  RunRecord as ContractRunRecord,
} from "../../../../src/studio/contracts/runs.js"
import type {
  StudioCompiledWorkflow,
  StudioCompiledWorkflowNode,
  StudioDraftValidationResult,
  StudioValidationDiagnostic,
} from "../../../../src/studio/contracts/validation.js"
import type {
  StudioWorkflowCatalog,
  StudioWorkflowSummary,
} from "../../../../src/studio/contracts/workflow-catalog.js"
import type {
  ArtifactList as ContractArtifactList,
  ArtifactMetadata as ContractArtifactMetadata,
  ArtifactPreview as ContractArtifactPreview,
  ArtifactSummary as ContractArtifactSummary,
} from "../../../../src/studio/contracts/artifacts.js"
import type {
  RunLogPage as ContractRunLogPage,
  StudioRunLogEntry as ContractRunLogEntry,
  StudioRunLogLevel as ContractRunLogLevel,
} from "../../../../src/studio/contracts/run-logs.js"
import type { StudioRunPlanInput as ContractRunPlanInput } from "../../../../src/studio/contracts/run-plan-input.js"
import type { StudioDraftTestRunPlanInput as ContractDraftTestRunPlanInput } from "../../../../src/studio/contracts/draft-test-run.js"
import type {
  StudioRunDispatchReceipt as ContractRunDispatchReceipt,
  StudioRunExecuteRequest as ContractRunExecuteRequest,
  StudioRunPlan as ContractRunPlan,
} from "../../../../src/studio/contracts/run-launch.js"
import type {
  StudioConfigurationApplyPlan,
  StudioConfigurationApplyResult,
  StudioConfigurationDraft,
  StudioConfigurationField,
  StudioConfigurationPatchRequest,
  StudioConfigurationValidationResponse,
  StudioModelConfiguration,
  StudioProviderConfiguration,
  StudioProviderProbeResult,
  StudioRepositoryConfiguration,
  StudioRuntimeConfiguration,
  StudioWorkflowConfiguration,
} from "../../../../src/studio/contracts/configuration.js"
import type {
  StudioGitRevisionId,
  StudioHistoryResource,
  StudioResourceHistoryCompareResponse,
  StudioResourceHistoryResponse,
  StudioResourceHistoryRestoreResponse,
  StudioResourceHistoryRevision,
} from "../../../../src/studio/contracts/resource-history.js"
import type {
  RunGraph as ContractRunGraph,
  RunGraphNode as ContractRunGraphNode,
  RunGraphNodeStatus as ContractRunGraphNodeStatus,
  RunGraphOverlay as ContractRunGraphOverlay,
  RunGraphResponse as ContractRunGraphResponse,
} from "../../../../src/studio/contracts/run-graph.js"
import type {
  RunNodeOutputComparisonResponse as ContractRunNodeOutputComparisonResponse,
  RunNodeOutputResponse as ContractRunNodeOutputResponse,
  RunNodeOutputSnapshot as ContractRunNodeOutputSnapshot,
} from "../../../../src/studio/contracts/run-node-output.js"

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = CoreJsonValue

export type ResourceRef = StudioResourceRef
export type ResourceKind = ResourceRef["kind"]
export type StudioPath = ContractStudioPath

export type CatalogDiagnostic = StudioCatalogDiagnostic
export type WorkflowSummary = StudioWorkflowSummary
export type WorkflowCatalog = StudioWorkflowCatalog
export type AgentCatalogItem = StudioAgentCatalogItem
export type AgentCatalog = StudioAgentCatalog
export type StudioMode = AgentCatalogItem["mode"]

export type StudioPresentation = StudioRegistrationPresentation
export type CapabilitySummary = StudioCapabilitySummary
export type CapabilityRegistration = StudioCapabilityRegistration
export type RegistrationKind = CapabilityRegistration["registration_kind"]
export type CapabilityCatalog = StudioCapabilityCatalog

export type DraftItem = StudioDraftItem
export type DraftFile = StudioDraftFile
export type DraftStatus = DraftItem["status"]
export type DraftListItem = StudioDraftListItem
export type DraftListPage = StudioDraftAuthoringListPage
export type ValidationDiagnostic = StudioValidationDiagnostic
export type CompiledWorkflowNode = StudioCompiledWorkflowNode
export type CompiledWorkflow = StudioCompiledWorkflow
export type DraftValidationResult = StudioDraftValidationResult
export type DraftValidationResponse = StudioDraftValidationResponse
export type DraftSourceView = StudioDraftSourceView
export type YamlSourceOperation = StudioYamlSourceOperation
export type DraftCreateRequest = StudioDraftCreateRequest
export type DraftCreateSource = StudioDraftCreateRequest["source"]
export type AgentDraftCreateSource =
  | { readonly mode: "existing" }
  | { readonly mode: "blank"; readonly model_profile: string }
export type WorkflowDraftCreateSource =
  | { readonly mode: "existing" }
  | { readonly mode: "blank" }
  | StudioDraftTemplateSelection
export type DraftTemplateCatalog = StudioDraftTemplateCatalog
export type DraftTemplate = DraftTemplateCatalog["templates"][number]
export type ExpressionEvaluation = StudioExpressionEvaluation
export type ExpressionEvaluationRequest = StudioExpressionEvaluationRequest
export type SchemaValidation = StudioSchemaValidation
export type SchemaValidationRequest = StudioSchemaValidationRequest

export type ApplyFileDiff = StudioApplyFileDiff
export type ApplyConflict = StudioApplyConflict
export type ApplyPlan = StudioApplyPlanResponse
export type ApplyResult = StudioApplyResult

export type RunStatus = RunDisplayStatus
export type RunSummary = RunCatalogSummary
export type RunCatalogPage = ContractRunCatalogPage
export type RunRecord = Omit<ContractRunRecord, "graph_snapshot_handle">
export type RunCatalogItem = Omit<ContractRunCatalogItem, "record"> & {
  readonly record: RunRecord
}
export type RunEvent = ContractRunEvent
export type RunEventPage = ContractRunEventPage
export type ArtifactSummary = ContractArtifactSummary
export type ArtifactList = ContractArtifactList
export type ArtifactMetadata = ContractArtifactMetadata
export type ArtifactPreview = ContractArtifactPreview
export type RunLogLevel = ContractRunLogLevel
export type RunLogEntry = ContractRunLogEntry
export type RunLogPage = ContractRunLogPage
export type RunPlanInput = ContractRunPlanInput
export type DraftTestRunPlanInput = ContractDraftTestRunPlanInput
export type RunPlan = ContractRunPlan
export type RunExecuteRequest = ContractRunExecuteRequest
export type RunDispatchReceipt = ContractRunDispatchReceipt
export type RunGraph = ContractRunGraph
export type RunGraphNode = ContractRunGraphNode
export type RunGraphNodeStatus = ContractRunGraphNodeStatus
export type RunGraphOverlay = ContractRunGraphOverlay
export type RunGraphResponse = ContractRunGraphResponse
export type RunNodeOutputSnapshot = ContractRunNodeOutputSnapshot
export type RunNodeOutputResponse = ContractRunNodeOutputResponse
export type RunNodeOutputComparisonResponse = ContractRunNodeOutputComparisonResponse

export type InputAdapterSummary = StudioInputAdapterSummary
export type InputAdapterCatalog = StudioInputAdapterCatalog
export type PublicInvocation = StudioPublicInvocation
export type AdapterPreview = StudioAdapterPreview
export type AdapterRoutingPreview = StudioAdapterRoutingPreview
export type RoutingDiagnostic = StudioRoutingDiagnostic
export type RoutingSimulation = StudioRoutingSimulation
export type RoutingEditor = StudioRoutingEditor
export type RoutingSaveRequest = StudioRoutingSaveRequest
export type RoutingSaveResult = StudioRoutingSaveResult
export type RouterDefinition = CoreRouterDefinition

export type WorkflowConfiguration = StudioWorkflowConfiguration
export type ConfigurationField = StudioConfigurationField
export type ConfigurationDraft = StudioConfigurationDraft
export type ConfigurationPatchRequest = StudioConfigurationPatchRequest
export type ConfigurationValidationResponse = StudioConfigurationValidationResponse
export type ConfigurationApplyPlan = StudioConfigurationApplyPlan
export type ConfigurationApplyResult = StudioConfigurationApplyResult
export type ModelConfiguration = StudioModelConfiguration
export type RepositoryConfiguration = StudioRepositoryConfiguration
export type ProviderConfiguration = StudioProviderConfiguration
export type ProviderProbeResult = StudioProviderProbeResult
export type RuntimeConfiguration = StudioRuntimeConfiguration

export type HistoryResource = StudioHistoryResource
export type GitRevisionId = StudioGitRevisionId
export type ResourceHistoryRevision = StudioResourceHistoryRevision
export type ResourceHistory = StudioResourceHistoryResponse
export type ResourceHistoryCompare = StudioResourceHistoryCompareResponse
export type ResourceHistoryRestore = StudioResourceHistoryRestoreResponse

export type SessionState = StudioSessionStateResponse

export type BootstrapState = {
  mode: "full" | "read-only-session"
  expiresAt?: string
}

export type StudioErrorEnvelope = StudioHttpErrorEnvelope
