import {
  collectRepoContextBuiltIn,
  finalCodeReviewReportBuiltIn,
  prepareWorktreeBuiltIn,
  preflightBuiltIn,
  validateCodeReviewFindingsBuiltIn
} from "../providers/github/built-ins.js";
import {
  collectWorktreeDiffBuiltIn,
  commitChangesBuiltIn,
  openChangeRequestBuiltIn,
  prepareImplementationWorktreeBuiltIn,
  pushBranchBuiltIn,
  recordAcceptanceDecisionBuiltIn,
  recordImplementationValidationBuiltIn,
  runValidationCommandsBuiltIn
} from "./implementation.js";
import {
  collectTaskContextBuiltIn,
  finalImplementationReportBuiltIn
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
  recordImplementationValidationBuiltIn,
  collectWorktreeDiffBuiltIn,
  recordAcceptanceDecisionBuiltIn,
  commitChangesBuiltIn,
  pushBranchBuiltIn,
  openChangeRequestBuiltIn,
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
