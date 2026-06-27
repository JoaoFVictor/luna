import { collectContextIntake } from "../../capabilities/context/collect-context.js";
import {
  collectWorktreeDiffBuiltIn,
  prepareCommitBuiltIn,
  prepareImplementationWorktreeBuiltIn,
  preparePushBuiltIn,
  recordAcceptanceDecisionBuiltIn,
  recordCommitLifecycleBuiltIn,
  recordImplementationValidationBuiltIn,
  recordPushLifecycleBuiltIn,
  runValidationCommandsBuiltIn
} from "../../core/built-ins/implementation.js";
import { collectContextBuiltIn } from "../../core/built-ins/context.js";
import {
  changeRequestCreateBuiltIn,
  gitCommitBuiltIn,
  gitPushBranchBuiltIn,
  gitStatusBuiltIn,
  localExecReadCommandBuiltIn,
  localExecWriteCommandBuiltIn,
  repositoryWorkspaceCaptureBuiltIn
} from "../../core/built-ins/catalog.js";
import { finalReportBuiltIn } from "../../core/reports/final-report.js";
import {
  createCollectTaskContextBuiltIn,
  createFinalImplementationReportBuiltIn,
  createProviderBuiltIns,
  defineTaskProviderBuiltIns
} from "../../providers/built-ins.js";
import {
  nativePlatformExtensions,
  type NativeWorkflowBuiltIns
} from "./native-platform-extensions.js";

const providerWorkflowBuiltInsBeforeContext = nativePlatformExtensions.flatMap(
  (extension) => extension.workflowBuiltIns?.beforeContext ?? []
);
const providerWorkflowBuiltInsAfterContext = nativePlatformExtensions.flatMap(
  (extension) => extension.workflowBuiltIns?.afterContext ?? []
);

const taskProviderBuiltIns = defineTaskProviderBuiltIns(
  nativePlatformExtensions.flatMap((extension) =>
    extension.taskBuiltIns === undefined
      ? []
      : [{ source: extension.id, builtIns: extension.taskBuiltIns }]
  )
);

const collectTaskContextBuiltIn =
  createCollectTaskContextBuiltIn(taskProviderBuiltIns);
const finalImplementationReportBuiltIn =
  createFinalImplementationReportBuiltIn(taskProviderBuiltIns);

export function createNativeProviderBuiltIns({
  workflowBuiltIns = {}
}: {
  readonly workflowBuiltIns?: NativeWorkflowBuiltIns;
} = {}) {
  return createProviderBuiltIns({
    dependencies: { collectContextIntake },
    steps: [
      ...providerWorkflowBuiltInsBeforeContext,
      ...(workflowBuiltIns.beforeContext ?? []),
      collectContextBuiltIn,
      ...providerWorkflowBuiltInsAfterContext,
      ...(workflowBuiltIns.afterContext ?? []),
      finalReportBuiltIn,
      localExecReadCommandBuiltIn,
      localExecWriteCommandBuiltIn,
      repositoryWorkspaceCaptureBuiltIn,
      gitStatusBuiltIn,
      gitCommitBuiltIn,
      gitPushBranchBuiltIn,
      changeRequestCreateBuiltIn,
      prepareImplementationWorktreeBuiltIn,
      collectTaskContextBuiltIn,
      runValidationCommandsBuiltIn,
      recordImplementationValidationBuiltIn,
      collectWorktreeDiffBuiltIn,
      recordAcceptanceDecisionBuiltIn,
      prepareCommitBuiltIn,
      recordCommitLifecycleBuiltIn,
      preparePushBuiltIn,
      recordPushLifecycleBuiltIn,
      finalImplementationReportBuiltIn
    ]
  });
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
