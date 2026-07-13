import { collectContextIntake } from "../../capabilities/context/collect-context.js";
import { officialCapabilityRegistry } from "../../capabilities/registry.js";
import type { CapabilityRegistry } from "../../core/capabilities/registry.js";
import {
  changeRequestPortsFromBuiltInOptions,
  createChangeRequestCreateBuiltIn
} from "../../capabilities/change-request/built-ins.js";
import {
  createPullRequestReviewPublishBuiltIn,
  pullRequestReviewPortsFromBuiltInOptions
} from "../../capabilities/pull-request-review/built-ins.js";
import {
  createSocialPostPrepareBuiltIn,
  createSocialPostPublishBuiltIn,
  socialPostApplyRevisionScopeBuiltIn,
  socialPostPortsFromBuiltInOptions
} from "../../capabilities/social-post/built-ins.js";
import {
  createImageGenerateBuiltIn,
  imageGenerationPortsFromBuiltInOptions
} from "../../capabilities/image-generation/built-ins.js";
import {
  gitPortsFromBuiltInOptions
} from "../../capabilities/git/shared.js";
import { createGitCommitBuiltIn } from "../../capabilities/git/commit.js";
import { runGit } from "../../capabilities/git/client.js";
import { createGitPushBranchBuiltIn } from "../../capabilities/git/push.js";
import { createGitStatusBuiltIn } from "../../capabilities/git/status.js";
import {
  createLocalExecCommandBuiltIn,
  localExecPortsFromBuiltInOptions
} from "../../capabilities/local-exec/built-ins.js";
import {
  createRepositoryWorkspaceCaptureBuiltIn,
  repositoryWorkspacePortsFromBuiltInOptions
} from "../../capabilities/repository-workspace/built-ins.js";
import { recordAcceptanceDecisionBuiltIn } from "../../capabilities/repository-change/acceptance-built-in.js";
import {
  prepareCommitBuiltIn,
  recordCommitLifecycleBuiltIn
} from "../../capabilities/repository-change/commit-built-ins.js";
import { collectWorktreeDiffBuiltIn } from "../../capabilities/repository-change/diff-built-in.js";
import { prepareImplementationWorktreeBuiltIn } from "../../capabilities/repository-change/prepare-worktree-built-in.js";
import {
  preparePushBuiltIn,
  recordPushLifecycleBuiltIn
} from "../../capabilities/repository-change/push-built-ins.js";
import { recordImplementationValidationBuiltIn } from "../../capabilities/repository-change/validation-built-in.js";
import { runValidationCommandsBuiltIn } from "../../capabilities/validation/built-ins.js";
import { collectContextBuiltIn } from "../../capabilities/context/built-ins.js";
import {
  mergeFindingsBuiltIn,
  validateFindingEvidenceBuiltIn
} from "../../capabilities/findings/built-ins.js";
import { createBuiltInStepCatalog } from "../../core/built-ins/catalog.js";
import type { BuiltInStepMetadata } from "../../core/built-ins/types.js";
import { collectRepoContextBuiltIn } from "../../capabilities/repository-diff/built-ins.js";
import { relatedContextBuiltIn } from "../../capabilities/repository-context/built-ins.js";
import { finalReportBuiltIn } from "../../capabilities/reports/final-report.js";
import { requireApprovalBuiltIn } from "../../capabilities/hitl/built-ins.js";
import {
  coverageCheckBuiltIn,
  coveragePlanBuiltIn,
  qualityCheckBuiltIn
} from "../../capabilities/review/built-ins.js";
import {
  createCollectTaskContextBuiltIn,
  createFinalImplementationReportBuiltIn,
  createProviderBuiltIns,
  defineTaskProviderBuiltIns,
  type TaskProviderBuiltIns
} from "../../providers/built-ins.js";
import {
  nativePlatformPlugins,
  type NativePlatformPluginRegistration,
  type NativeWorkflowBuiltIns
} from "./native-platform-plugins.js";

export function workflowBuiltInsFromPlugins(
  plugins: readonly NativePlatformPluginRegistration[]
): NativeWorkflowBuiltIns {
  return {
    beforeContext: plugins.flatMap((plugin) =>
      plugin.workflowBuiltIns?.beforeContext ?? []
    ),
    afterContext: plugins.flatMap((plugin) =>
      plugin.workflowBuiltIns?.afterContext ?? []
    ),
    builtIns: plugins.flatMap((plugin) =>
      plugin.builtIns ?? []
    )
  };
}

export function taskProviderBuiltInsFromPlugins(
  plugins: readonly NativePlatformPluginRegistration[]
): Readonly<Record<string, TaskProviderBuiltIns>> {
  return defineTaskProviderBuiltIns(plugins.flatMap((plugin) =>
    plugin.taskBuiltIns === undefined
      ? []
      : [{ source: plugin.taskSource ?? plugin.id, builtIns: plugin.taskBuiltIns }]
  ));
}

const defaultWorkflowBuiltIns = workflowBuiltInsFromPlugins(nativePlatformPlugins);
const defaultTaskProviderBuiltIns = taskProviderBuiltInsFromPlugins(nativePlatformPlugins);

export const localExecReadCommandBuiltIn = createLocalExecCommandBuiltIn(
  localExecPortsFromBuiltInOptions,
  "local-exec.command.read"
);
export const localExecWriteCommandBuiltIn = createLocalExecCommandBuiltIn(
  localExecPortsFromBuiltInOptions,
  "local-exec.command.write"
);
export const repositoryWorkspaceCaptureBuiltIn =
  createRepositoryWorkspaceCaptureBuiltIn(
    repositoryWorkspacePortsFromBuiltInOptions
  );
export const gitStatusBuiltIn = createGitStatusBuiltIn(
  gitPortsFromBuiltInOptions
);
export const gitCommitBuiltIn = createGitCommitBuiltIn(
  gitPortsFromBuiltInOptions
);
export const gitPushBranchBuiltIn = createGitPushBranchBuiltIn(
  gitPortsFromBuiltInOptions
);
export const changeRequestCreateBuiltIn = createChangeRequestCreateBuiltIn(
  changeRequestPortsFromBuiltInOptions
);
export const pullRequestReviewPublishBuiltIn =
  createPullRequestReviewPublishBuiltIn(
    pullRequestReviewPortsFromBuiltInOptions
  );
export const socialPostPublishBuiltIn = createSocialPostPublishBuiltIn(
  socialPostPortsFromBuiltInOptions
);
export const socialPostPrepareBuiltIn = createSocialPostPrepareBuiltIn(
  socialPostPortsFromBuiltInOptions
);
export const imageGenerateBuiltIn = createImageGenerateBuiltIn(
  imageGenerationPortsFromBuiltInOptions
);

export function createNativeProviderBuiltIns({
  workflowBuiltIns = defaultWorkflowBuiltIns,
  taskProviderBuiltIns = defaultTaskProviderBuiltIns,
  capabilityRegistry = officialCapabilityRegistry
}: {
  readonly workflowBuiltIns?: NativeWorkflowBuiltIns;
  readonly taskProviderBuiltIns?: Readonly<Record<string, TaskProviderBuiltIns>>;
  readonly capabilityRegistry?: Pick<CapabilityRegistry, "registrations">;
} = {}) {
  const collectTaskContext = createCollectTaskContextBuiltIn(taskProviderBuiltIns);
  const finalImplementationReport = createFinalImplementationReportBuiltIn(
    taskProviderBuiltIns
  );
  const collectNativeContextIntake: typeof collectContextIntake = (input) =>
    collectContextIntake({
      ...input,
      capabilityRegistry
    });

  return createProviderBuiltIns({
    dependencies: { collectContextIntake: collectNativeContextIntake, runGit },
    steps: [
      ...(workflowBuiltIns.beforeContext ?? []),
      collectContextBuiltIn,
      ...(workflowBuiltIns.afterContext ?? []),
      collectRepoContextBuiltIn,
      relatedContextBuiltIn,
      coveragePlanBuiltIn,
      mergeFindingsBuiltIn,
      coverageCheckBuiltIn,
      qualityCheckBuiltIn,
      validateFindingEvidenceBuiltIn,
      requireApprovalBuiltIn,
      ...(workflowBuiltIns.builtIns ?? []),
      finalReportBuiltIn,
      localExecReadCommandBuiltIn,
      localExecWriteCommandBuiltIn,
      repositoryWorkspaceCaptureBuiltIn,
      gitStatusBuiltIn,
      gitCommitBuiltIn,
      gitPushBranchBuiltIn,
      changeRequestCreateBuiltIn,
      pullRequestReviewPublishBuiltIn,
      socialPostApplyRevisionScopeBuiltIn,
      socialPostPrepareBuiltIn,
      socialPostPublishBuiltIn,
      imageGenerateBuiltIn,
      prepareImplementationWorktreeBuiltIn,
      collectTaskContext,
      runValidationCommandsBuiltIn,
      recordImplementationValidationBuiltIn,
      collectWorktreeDiffBuiltIn,
      recordAcceptanceDecisionBuiltIn,
      prepareCommitBuiltIn,
      recordCommitLifecycleBuiltIn,
      preparePushBuiltIn,
      recordPushLifecycleBuiltIn,
      finalImplementationReport
    ]
  });
}

export function nativeBuiltInMetadata(
  registry: {
    has(name: string): boolean;
    require(name: string): { readonly metadata?: BuiltInStepMetadata };
  },
  node: { readonly capability_id: string }
): BuiltInStepMetadata {
  return registry.has(node.capability_id)
    ? registry.require(node.capability_id).metadata ?? {}
    : {};
}

export const nativeProviderBuiltIns = createNativeProviderBuiltIns();

export const builtInStepNames = nativeProviderBuiltIns.builtInStepNames;
export const defaultBuiltInSteps = nativeProviderBuiltIns.builtInSteps;
export const defaultProviderBuiltInStepRegistry =
  nativeProviderBuiltIns.builtInStepRegistry;
export const isBuiltInStepName = nativeProviderBuiltIns.isBuiltInStepName;
export const runBuiltInStep = nativeProviderBuiltIns.runBuiltInStep;
export const defaultProviderWorkflowBuiltIns =
  nativeProviderBuiltIns.workflowBuiltIns;
export const defaultBuiltInCatalog = createBuiltInStepCatalog(defaultBuiltInSteps);
