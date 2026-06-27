import { collectContextIntake } from "../capabilities/context/collect-context.js";
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
} from "../core/built-ins/implementation.js";
import { collectContextBuiltIn } from "../core/built-ins/context.js";
import {
  changeRequestCreateBuiltIn,
  gitCommitBuiltIn,
  gitPushBranchBuiltIn,
  gitStatusBuiltIn,
  localExecReadCommandBuiltIn,
  localExecWriteCommandBuiltIn,
  repositoryWorkspaceCaptureBuiltIn
} from "../core/built-ins/catalog.js";
import { finalReportBuiltIn } from "../core/reports/final-report.js";
import {
  collectRepoContextBuiltIn,
  finalCodeReviewReportBuiltIn,
  prepareWorktreeBuiltIn,
  preflightBuiltIn,
  validateCodeReviewFindingsBuiltIn
} from "./github/built-ins.js";
import {
  collectTaskContextBuiltIn as collectJiraTaskContextBuiltIn,
  finalImplementationReportBuiltIn as finalJiraImplementationReportBuiltIn
} from "./jira/built-ins.js";
import {
  collectTaskContextBuiltIn as collectPlaneTaskContextBuiltIn,
  finalImplementationReportBuiltIn as finalPlaneImplementationReportBuiltIn
} from "./plane/built-ins.js";
import {
  createCollectTaskContextBuiltIn,
  createFinalImplementationReportBuiltIn,
  createProviderBuiltIns,
  defineTaskProviderBuiltIns
} from "./built-ins.js";

const taskProviderBuiltIns = defineTaskProviderBuiltIns([
  {
    source: "jira",
    builtIns: {
      collectTaskContext: collectJiraTaskContextBuiltIn,
      finalImplementationReport: finalJiraImplementationReportBuiltIn
    }
  },
  {
    source: "plane",
    builtIns: {
      collectTaskContext: collectPlaneTaskContextBuiltIn,
      finalImplementationReport: finalPlaneImplementationReportBuiltIn
    }
  }
]);

const collectTaskContextBuiltIn =
  createCollectTaskContextBuiltIn(taskProviderBuiltIns);
const finalImplementationReportBuiltIn =
  createFinalImplementationReportBuiltIn(taskProviderBuiltIns);

export const nativeProviderBuiltIns = createProviderBuiltIns({
  dependencies: { collectContextIntake },
  steps: [
    preflightBuiltIn,
    prepareWorktreeBuiltIn,
    collectContextBuiltIn,
    collectRepoContextBuiltIn,
    validateCodeReviewFindingsBuiltIn,
    finalCodeReviewReportBuiltIn,
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

export const builtInStepNames = nativeProviderBuiltIns.builtInStepNames;
export const defaultBuiltInSteps = nativeProviderBuiltIns.builtInSteps;
export const defaultProviderBuiltInStepRegistry =
  nativeProviderBuiltIns.builtInStepRegistry;
export const isBuiltInStepName = nativeProviderBuiltIns.isBuiltInStepName;
export const runBuiltInStep = nativeProviderBuiltIns.runBuiltInStep;
export const defaultProviderWorkflowBuiltIns =
  nativeProviderBuiltIns.workflowBuiltIns;
