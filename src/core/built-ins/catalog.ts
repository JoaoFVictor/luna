import {
  collectRepoContextBuiltIn,
  finalCodeReviewReportBuiltIn,
  prepareWorktreeBuiltIn,
  preflightBuiltIn,
  validateCodeReviewFindingsBuiltIn
} from "./code-review.js";
import {
  collectTaskContextBuiltIn,
  collectWorktreeDiffBuiltIn,
  commitChangesBuiltIn,
  finalImplementationReportBuiltIn,
  openPullRequestBuiltIn,
  prepareImplementationWorktreeBuiltIn,
  pushBranchBuiltIn,
  runValidationCommandsBuiltIn
} from "./implementation.js";

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
