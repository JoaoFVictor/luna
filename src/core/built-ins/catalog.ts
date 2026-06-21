import {
  collectRepoContextBuiltIn,
  finalCodeReviewReportBuiltIn,
  openPullRequestBuiltIn,
  prepareWorktreeBuiltIn,
  preflightBuiltIn,
  validateCodeReviewFindingsBuiltIn
} from "../providers/github/built-ins.js";
import {
  collectTaskContextBuiltIn,
  collectWorktreeDiffBuiltIn,
  commitChangesBuiltIn,
  finalImplementationReportBuiltIn,
  prepareImplementationWorktreeBuiltIn,
  pushBranchBuiltIn,
  runValidationCommandsBuiltIn
} from "../providers/jira/built-ins.js";

export const defaultBuiltInSteps = Object.freeze([
  preflightBuiltIn,
  prepareWorktreeBuiltIn,
  collectRepoContextBuiltIn,
  validateCodeReviewFindingsBuiltIn,
  finalCodeReviewReportBuiltIn,
  prepareImplementationWorktreeBuiltIn,
  collectTaskContextBuiltIn,
  runValidationCommandsBuiltIn,
  collectWorktreeDiffBuiltIn,
  commitChangesBuiltIn,
  pushBranchBuiltIn,
  openPullRequestBuiltIn,
  finalImplementationReportBuiltIn
] as const);

export type BuiltInStepName = typeof defaultBuiltInSteps[number]["name"];

export const builtInStepNames = Object.freeze(
  defaultBuiltInSteps.map((step) => step.name)
);

const builtInStepNameSet: ReadonlySet<string> = new Set(builtInStepNames);

export function isBuiltInStepName(value: string): value is BuiltInStepName {
  return builtInStepNameSet.has(value);
}
