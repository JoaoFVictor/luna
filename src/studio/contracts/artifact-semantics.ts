/**
 * Semantic view ids understood by this Studio release. Unknown valid ids remain
 * forward-compatible and use the generic artifact preview.
 */
export const STUDIO_ARTIFACT_SEMANTIC_TYPES = {
  reviewFindings: "luna.review.findings.v1",
  reviewCoveragePlan: "luna.review.coverage-plan.v1",
  reviewCoverageCheck: "luna.review.coverage-check.v1",
  reviewAcceptance: "luna.review.acceptance.v1",
  reviewProviderPublish: "luna.review.provider-publish.v1",
  implementationWorktree: "luna.implementation.worktree.v1",
  implementationPlan: "luna.implementation.plan.v1",
  implementationGates: "luna.implementation.gates.v1",
  implementationValidation: "luna.implementation.validation.v1",
  implementationDiff: "luna.implementation.diff.v1",
  implementationCommit: "luna.implementation.commit.v1",
  implementationPush: "luna.implementation.push.v1",
  implementationChangeRequest: "luna.implementation.change-request.v1"
} as const;

export type StudioKnownArtifactSemanticType =
  typeof STUDIO_ARTIFACT_SEMANTIC_TYPES[keyof typeof STUDIO_ARTIFACT_SEMANTIC_TYPES];
