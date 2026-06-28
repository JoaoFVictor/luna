import type { BuiltInStepMetadata } from "./types.js";

function repositoryLock(): { resource: "repository"; mode: "exclusive" } {
  return { resource: "repository", mode: "exclusive" };
}

export const emptyBuiltInMetadata = Object.freeze({});

export const repositoryRequiredMetadata = Object.freeze({
  requiresRepository: true
} satisfies BuiltInStepMetadata);

export const prepareWorktreeMetadata = Object.freeze({
  capturesWorkspace: true,
  requiresRepository: true,
  locks: Object.freeze([repositoryLock()])
} satisfies BuiltInStepMetadata);

export const finalReportMetadata = Object.freeze({
  deferredLifecycle: "final_report"
} satisfies BuiltInStepMetadata);

export const repositoryWorkspaceCaptureMetadata = Object.freeze({
  capturesWorkspace: true,
  requiresRepository: true
} satisfies BuiltInStepMetadata);

export const gitStatusMetadata = Object.freeze({
  requiresRepository: true
} satisfies BuiltInStepMetadata);

export const gitCommitMetadata = Object.freeze({
  requiresRepository: true,
  locks: Object.freeze([repositoryLock()])
} satisfies BuiltInStepMetadata);

export const gitPushBranchMetadata = Object.freeze({
  requiresRepository: true,
  locks: Object.freeze([repositoryLock()])
} satisfies BuiltInStepMetadata);
