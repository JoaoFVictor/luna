import type { InputAdapter } from "../../adapters/types.js";
import type { BuiltInStep } from "../../core/built-ins/types.js";
import type { ChangeRequestProviderFactory } from "../../core/change-request/contracts.js";
import { githubPrUrlAdapter } from "../../adapters/github-pr-url/index.js";
import {
  collectRepoContextBuiltIn,
  finalCodeReviewReportBuiltIn,
  preflightBuiltIn,
  prepareWorktreeBuiltIn,
  validateCodeReviewFindingsBuiltIn
} from "../../providers/github/built-ins.js";
import { createGitHubChangeRequestProviderFactory } from "../../providers/github/change-request/factory.js";
import { jiraTaskUrlAdapter } from "../../adapters/jira-task-url/index.js";
import {
  collectTaskContextBuiltIn as collectJiraTaskContextBuiltIn,
  finalImplementationReportBuiltIn as finalJiraImplementationReportBuiltIn
} from "../../providers/jira/built-ins.js";
import { planeTaskUrlAdapter } from "../../adapters/plane-task-url/index.js";
import {
  collectTaskContextBuiltIn as collectPlaneTaskContextBuiltIn,
  finalImplementationReportBuiltIn as finalPlaneImplementationReportBuiltIn
} from "../../providers/plane/built-ins.js";
import type { TaskProviderBuiltIns } from "../../providers/built-ins.js";

export type NativeWorkflowBuiltIns = {
  readonly beforeContext?: readonly BuiltInStep[];
  readonly afterContext?: readonly BuiltInStep[];
};

export type NativePlatformExtension = {
  readonly id: string;
  readonly inputAdapters?: readonly InputAdapter[];
  readonly workflowBuiltIns?: NativeWorkflowBuiltIns;
  readonly taskBuiltIns?: TaskProviderBuiltIns;
  readonly changeRequestProviderFactories?: readonly ChangeRequestProviderFactory[];
};

export const nativePlatformExtensions: readonly NativePlatformExtension[] = Object.freeze([
  {
    id: "github",
    inputAdapters: [githubPrUrlAdapter],
    workflowBuiltIns: {
      beforeContext: [preflightBuiltIn, prepareWorktreeBuiltIn],
      afterContext: [
        collectRepoContextBuiltIn,
        validateCodeReviewFindingsBuiltIn,
        finalCodeReviewReportBuiltIn
      ]
    },
    changeRequestProviderFactories: [createGitHubChangeRequestProviderFactory({})]
  },
  {
    id: "jira",
    inputAdapters: [jiraTaskUrlAdapter],
    taskBuiltIns: {
      collectTaskContext: collectJiraTaskContextBuiltIn,
      finalImplementationReport: finalJiraImplementationReportBuiltIn
    }
  },
  {
    id: "plane",
    inputAdapters: [planeTaskUrlAdapter],
    taskBuiltIns: {
      collectTaskContext: collectPlaneTaskContextBuiltIn,
      finalImplementationReport: finalPlaneImplementationReportBuiltIn
    }
  }
]);
