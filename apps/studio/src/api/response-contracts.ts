import { z } from "zod"

import { RouterDefinitionSchema } from "../../../../src/core/router/router-definition.js"
import {
  StudioApplyPlanResponseSchema,
  StudioApplyResultSchema,
} from "../../../../src/studio/contracts/apply.js"
import { StudioCapabilityCatalogSchema } from "../../../../src/studio/contracts/capability-catalog.js"
import { StudioAgentCatalogSchema } from "../../../../src/studio/contracts/catalog.js"
import { StudioSessionStateResponseSchema } from "../../../../src/studio/contracts/control-api.js"
import {
  StudioDraftAuthoringListPageSchema,
  StudioDraftItemSchema,
  StudioDraftSourceViewSchema,
  StudioDraftTemplateCatalogSchema,
  StudioDraftValidationResponseSchema,
} from "../../../../src/studio/contracts/draft-authoring.js"
import {
  StudioAdapterPreviewSchema,
  StudioAdapterRoutingPreviewSchema,
  StudioInputAdapterCatalogSchema,
  StudioRoutingEditorSchema,
  StudioRoutingSaveResultSchema,
  StudioRoutingSimulationSchema,
} from "../../../../src/studio/contracts/input-routing.js"
import {
  RunCatalogItemSchema,
  RunCatalogPageSchema,
  RunEventSchema,
  RunEventPageSchema,
} from "../../../../src/studio/contracts/runs.js"
import { StudioRunEventStreamCompleteSchema } from "../../../../src/studio/contracts/run-api.js"
import { StudioWorkflowCatalogSchema } from "../../../../src/studio/contracts/workflow-catalog.js"
import {
  ArtifactListSchema,
  ArtifactMetadataSchema,
  ArtifactPreviewSchema,
} from "../../../../src/studio/contracts/artifacts.js"
import { RunLogPageSchema } from "../../../../src/studio/contracts/run-logs.js"
import {
  StudioRunDispatchReceiptSchema,
  StudioRunPlanSchema,
} from "../../../../src/studio/contracts/run-launch.js"
import { StudioExpressionEvaluationSchema } from "../../../../src/studio/contracts/expression-evaluation.js"
import { StudioSchemaValidationSchema } from "../../../../src/studio/contracts/schema-validation.js"
import {
  StudioConfigurationApplyPlanSchema,
  StudioConfigurationApplyResultSchema,
  StudioConfigurationDraftSchema,
  StudioConfigurationValidationResponseSchema,
  StudioModelConfigurationSchema,
  StudioProviderConfigurationSchema,
  StudioRepositoryConfigurationSchema,
  StudioRuntimeConfigurationSchema,
  StudioWorkflowConfigurationSchema,
} from "../../../../src/studio/contracts/configuration.js"
import {
  StudioResourceHistoryCompareResponseSchema,
  StudioResourceHistoryResponseSchema,
  StudioResourceHistoryRestoreResponseSchema,
} from "../../../../src/studio/contracts/resource-history.js"
import { RunGraphResponseSchema } from "../../../../src/studio/contracts/run-graph.js"

export type StudioResponseContract<T> = {
  parse(value: unknown): T
}

const PublicRunCatalogItemSchema = RunCatalogItemSchema.superRefine(
  (item, context) => {
    if (item.record.graph_snapshot_handle !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["record", "graph_snapshot_handle"],
        message: "Internal graph handles must not cross the Studio API boundary",
      })
    }
  },
).transform((item) => {
  const { graph_snapshot_handle: _internalHandle, ...record } = item.record
  return { ...item, record }
})

export const studioResponseContracts = {
  empty: z.undefined(),
  session: StudioSessionStateResponseSchema,
  workflows: StudioWorkflowCatalogSchema,
  agents: StudioAgentCatalogSchema,
  library: StudioCapabilityCatalogSchema,
  draftList: StudioDraftAuthoringListPageSchema,
  draft: StudioDraftItemSchema,
  draftSourceView: StudioDraftSourceViewSchema,
  draftTemplates: StudioDraftTemplateCatalogSchema,
  draftValidation: StudioDraftValidationResponseSchema,
  applyPlan: StudioApplyPlanResponseSchema,
  applyResult: StudioApplyResultSchema,
  runCatalog: RunCatalogPageSchema,
  run: PublicRunCatalogItemSchema,
  runGraph: RunGraphResponseSchema,
  runEvent: RunEventSchema,
  runTimeline: RunEventPageSchema,
  runEventStreamComplete: StudioRunEventStreamCompleteSchema,
  artifacts: ArtifactListSchema,
  artifactMetadata: ArtifactMetadataSchema,
  artifactPreview: ArtifactPreviewSchema,
  runLogs: RunLogPageSchema,
  runPlan: StudioRunPlanSchema,
  runDispatchReceipt: StudioRunDispatchReceiptSchema,
  inputAdapters: StudioInputAdapterCatalogSchema,
  adapterPreview: StudioAdapterPreviewSchema,
  adapterRoutingPreview: StudioAdapterRoutingPreviewSchema,
  routingSimulation: StudioRoutingSimulationSchema,
  routing: RouterDefinitionSchema,
  routingEditor: StudioRoutingEditorSchema,
  routingSaveResult: StudioRoutingSaveResultSchema,
  expressionEvaluation: StudioExpressionEvaluationSchema,
  schemaValidation: StudioSchemaValidationSchema,
  workflowConfiguration: StudioWorkflowConfigurationSchema,
  configurationDraft: StudioConfigurationDraftSchema,
  configurationValidation: StudioConfigurationValidationResponseSchema,
  configurationApplyPlan: StudioConfigurationApplyPlanSchema,
  configurationApplyResult: StudioConfigurationApplyResultSchema,
  modelConfiguration: StudioModelConfigurationSchema,
  repositoryConfiguration: StudioRepositoryConfigurationSchema,
  providerConfiguration: StudioProviderConfigurationSchema,
  runtimeConfiguration: StudioRuntimeConfigurationSchema,
  resourceHistory: StudioResourceHistoryResponseSchema,
  resourceHistoryCompare: StudioResourceHistoryCompareResponseSchema,
  resourceHistoryRestore: StudioResourceHistoryRestoreResponseSchema,
} as const
