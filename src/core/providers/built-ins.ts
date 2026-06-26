import {
  collectWorktreeDiffBuiltIn,
  commitChangesBuiltIn,
  prepareImplementationWorktreeBuiltIn,
  pushBranchBuiltIn,
  recordAcceptanceDecisionBuiltIn,
  recordImplementationValidationBuiltIn,
  runValidationCommandsBuiltIn
} from "../built-ins/implementation.js";
import { collectContextBuiltIn } from "../built-ins/context.js";
import { finalReportBuiltIn } from "../../capabilities/reports/final-report.js";
import {
  createBuiltInStepCatalog,
  gitCommitBuiltIn,
  gitPushBranchBuiltIn,
  gitStatusBuiltIn,
  changeRequestCreateBuiltIn,
  localExecReadCommandBuiltIn,
  localExecWriteCommandBuiltIn,
  repositoryWorkspaceCaptureBuiltIn
} from "../built-ins/catalog.js";
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
import { builtInError } from "../built-ins/errors.js";
import { defineBuiltInStep } from "../built-ins/registry.js";
import { finalReportMetadata } from "../built-ins/metadata.js";
import type { Invocation } from "../router/invocation.js";
import type { BuiltInStep } from "../built-ins/types.js";

type TaskProviderBuiltIns = {
  collectTaskContext: BuiltInStep<"collect_task_context">;
  finalImplementationReport: BuiltInStep<"final_implementation_report">;
};

const taskProviderBuiltIns: Record<string, TaskProviderBuiltIns> = {
  jira: {
    collectTaskContext: collectJiraTaskContextBuiltIn,
    finalImplementationReport: finalJiraImplementationReportBuiltIn
  },
  plane: {
    collectTaskContext: collectPlaneTaskContextBuiltIn,
    finalImplementationReport: finalPlaneImplementationReportBuiltIn
  }
};

function invocationSourceFrom(state: { invocation?: unknown }): string {
  const source = (state.invocation as Partial<Invocation> | undefined)?.source;

  if (typeof source !== "string" || source.length === 0) {
    throw builtInError(
      "Built-in step requires invocation.source",
      "built_in_unsupported"
    );
  }

  return source;
}

export const collectTaskContextBuiltIn = defineBuiltInStep({
  name: "collect_task_context",
  run(options) {
    const source = invocationSourceFrom(options.state);
    const provider = taskProviderBuiltIns[source];

    if (provider !== undefined) {
      return provider.collectTaskContext.run(options);
    }

    throw builtInError(
      `Built-in step does not support task context for source: ${source}`,
      "built_in_unsupported"
    );
  }
});

export const finalImplementationReportBuiltIn = defineBuiltInStep({
  name: "final_implementation_report",
  metadata: finalReportMetadata,
  run(options) {
    const source = invocationSourceFrom(options.state);
    const provider = taskProviderBuiltIns[source];

    if (provider !== undefined) {
      return provider.finalImplementationReport.run(options);
    }

    throw builtInError(
      `Built-in step does not support implementation reports for source: ${source}`,
      "built_in_unsupported"
    );
  }
});

export const defaultBuiltInSteps = Object.freeze([
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
  commitChangesBuiltIn,
  pushBranchBuiltIn,
  finalImplementationReportBuiltIn
] as const);

const defaultProviderBuiltInCatalog =
  createBuiltInStepCatalog(defaultBuiltInSteps);

export const builtInStepNames = defaultProviderBuiltInCatalog.names;
export const defaultProviderBuiltInStepRegistry =
  defaultProviderBuiltInCatalog.registry;
export const isBuiltInStepName =
  defaultProviderBuiltInCatalog.isBuiltInStepName;
export const runBuiltInStep = defaultProviderBuiltInCatalog.runBuiltInStep;
