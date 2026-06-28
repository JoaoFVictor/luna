import { collectContextIntake } from "../../capabilities/context/collect-context.js";
import {
  changeRequestPortsFromBuiltInOptions,
  createChangeRequestCreateBuiltIn
} from "../../core/change-request/built-ins.js";
import {
  createGitCommitBuiltIn,
  createGitPushBranchBuiltIn,
  createGitStatusBuiltIn,
  gitPortsFromBuiltInOptions
} from "../../core/git/built-ins.js";
import {
  createLocalExecCommandBuiltIn,
  localExecPortsFromBuiltInOptions
} from "../../core/local-exec/built-ins.js";
import {
  createRepositoryWorkspaceCaptureBuiltIn,
  repositoryWorkspacePortsFromBuiltInOptions
} from "../../core/repository-workspace/built-ins.js";
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
import { createBuiltInStepCatalog } from "../../core/built-ins/catalog.js";
import { finalReportBuiltIn } from "../../core/reports/final-report.js";
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

export function createNativeProviderBuiltIns({
  workflowBuiltIns = defaultWorkflowBuiltIns,
  taskProviderBuiltIns = defaultTaskProviderBuiltIns
}: {
  readonly workflowBuiltIns?: NativeWorkflowBuiltIns;
  readonly taskProviderBuiltIns?: Readonly<Record<string, TaskProviderBuiltIns>>;
} = {}) {
  const collectTaskContext = createCollectTaskContextBuiltIn(taskProviderBuiltIns);
  const finalImplementationReport = createFinalImplementationReportBuiltIn(
    taskProviderBuiltIns
  );

  return createProviderBuiltIns({
    dependencies: { collectContextIntake },
    steps: [
      ...(workflowBuiltIns.beforeContext ?? []),
      collectContextBuiltIn,
      ...(workflowBuiltIns.afterContext ?? []),
      ...(workflowBuiltIns.builtIns ?? []),
      finalReportBuiltIn,
      localExecReadCommandBuiltIn,
      localExecWriteCommandBuiltIn,
      repositoryWorkspaceCaptureBuiltIn,
      gitStatusBuiltIn,
      gitCommitBuiltIn,
      gitPushBranchBuiltIn,
      changeRequestCreateBuiltIn,
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
