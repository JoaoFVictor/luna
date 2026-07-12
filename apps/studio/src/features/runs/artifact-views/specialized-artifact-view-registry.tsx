import type { ReactNode } from "react"
import type { z } from "zod"

import {
  STUDIO_ARTIFACT_SEMANTIC_TYPES,
  type StudioKnownArtifactSemanticType,
} from "../../../../../../src/studio/contracts/artifact-semantics.js"
import {
  ImplementationChangeRequestViewSchema,
  ImplementationCommitViewSchema,
  ImplementationDiffViewSchema,
  ImplementationGatesViewSchema,
  ImplementationPlanViewSchema,
  ImplementationPushViewSchema,
  ImplementationValidationViewSchema,
  ImplementationWorktreeViewSchema,
} from "./implementation-schemas"
import {
  ImplementationChangeRequestView,
  ImplementationCommitView,
  ImplementationDiffView,
  ImplementationGatesView,
  ImplementationPlanView,
  ImplementationPushView,
  ImplementationValidationView,
  ImplementationWorktreeView,
} from "./implementation-views"
import {
  ReviewAcceptanceViewSchema,
  ReviewCoverageCheckViewSchema,
  ReviewCoveragePlanViewSchema,
  ReviewFindingsViewSchema,
  ReviewProviderPublishViewSchema,
} from "./review-schemas"
import {
  ReviewAcceptanceView,
  ReviewCoverageView,
  ReviewFindingsView,
  ReviewProviderPublishView,
} from "./review-views"

type SpecializedArtifactViewProjection =
  | { readonly kind: "valid"; readonly content: ReactNode }
  | { readonly kind: "unsupported" }

type ArtifactViewDefinition = {
  readonly project: (value: unknown) => SpecializedArtifactViewProjection
}

function defineArtifactView<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  render: (value: z.output<TSchema>) => ReactNode,
): ArtifactViewDefinition {
  return {
    project(value) {
      const parsed = schema.safeParse(value)
      return parsed.success
        ? { kind: "valid", content: render(parsed.data) }
        : { kind: "unsupported" }
    },
  }
}

const viewDefinitions = {
  [STUDIO_ARTIFACT_SEMANTIC_TYPES.reviewFindings]:
    defineArtifactView(ReviewFindingsViewSchema, (value) => (
      <ReviewFindingsView value={value} />
    )),
  [STUDIO_ARTIFACT_SEMANTIC_TYPES.reviewCoveragePlan]:
    defineArtifactView(ReviewCoveragePlanViewSchema, (value) => (
      <ReviewCoverageView value={value} />
    )),
  [STUDIO_ARTIFACT_SEMANTIC_TYPES.reviewCoverageCheck]:
    defineArtifactView(ReviewCoverageCheckViewSchema, (value) => (
      <ReviewCoverageView value={value} />
    )),
  [STUDIO_ARTIFACT_SEMANTIC_TYPES.reviewAcceptance]:
    defineArtifactView(ReviewAcceptanceViewSchema, (value) => (
      <ReviewAcceptanceView value={value} />
    )),
  [STUDIO_ARTIFACT_SEMANTIC_TYPES.reviewProviderPublish]:
    defineArtifactView(ReviewProviderPublishViewSchema, (value) => (
      <ReviewProviderPublishView value={value} />
    )),
  [STUDIO_ARTIFACT_SEMANTIC_TYPES.implementationWorktree]:
    defineArtifactView(ImplementationWorktreeViewSchema, (value) => (
      <ImplementationWorktreeView value={value} />
    )),
  [STUDIO_ARTIFACT_SEMANTIC_TYPES.implementationPlan]:
    defineArtifactView(ImplementationPlanViewSchema, (value) => (
      <ImplementationPlanView value={value} />
    )),
  [STUDIO_ARTIFACT_SEMANTIC_TYPES.implementationGates]:
    defineArtifactView(ImplementationGatesViewSchema, (value) => (
      <ImplementationGatesView value={value} />
    )),
  [STUDIO_ARTIFACT_SEMANTIC_TYPES.implementationValidation]:
    defineArtifactView(ImplementationValidationViewSchema, (value) => (
      <ImplementationValidationView value={value} />
    )),
  [STUDIO_ARTIFACT_SEMANTIC_TYPES.implementationDiff]:
    defineArtifactView(ImplementationDiffViewSchema, (value) => (
      <ImplementationDiffView value={value} />
    )),
  [STUDIO_ARTIFACT_SEMANTIC_TYPES.implementationCommit]:
    defineArtifactView(ImplementationCommitViewSchema, (value) => (
      <ImplementationCommitView value={value} />
    )),
  [STUDIO_ARTIFACT_SEMANTIC_TYPES.implementationPush]:
    defineArtifactView(ImplementationPushViewSchema, (value) => (
      <ImplementationPushView value={value} />
    )),
  [STUDIO_ARTIFACT_SEMANTIC_TYPES.implementationChangeRequest]:
    defineArtifactView(ImplementationChangeRequestViewSchema, (value) => (
      <ImplementationChangeRequestView value={value} />
    )),
} satisfies Record<StudioKnownArtifactSemanticType, ArtifactViewDefinition>

const viewRegistry = new Map<string, ArtifactViewDefinition>(
  Object.entries(viewDefinitions),
)

export const KNOWN_SPECIALIZED_ARTIFACT_SEMANTIC_TYPES = Object.freeze(
  Object.keys(viewDefinitions),
)

export function projectSpecializedArtifactView(
  semanticType: string,
  value: unknown,
): SpecializedArtifactViewProjection {
  return viewRegistry.get(semanticType)?.project(value) ?? { kind: "unsupported" }
}
