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
import {
  createBuiltInStepCatalog,
  openChangeRequestBuiltIn
} from "../built-ins/catalog.js";
import {
  collectRepoContextBuiltIn,
  finalCodeReviewReportBuiltIn,
  prepareWorktreeBuiltIn,
  preflightBuiltIn,
  validateCodeReviewFindingsBuiltIn
} from "./github/built-ins.js";
import {
  collectTaskContextBuiltIn,
  finalImplementationReportBuiltIn
} from "./jira/built-ins.js";

export { openChangeRequestBuiltIn };

export const defaultBuiltInSteps = Object.freeze([
  preflightBuiltIn,
  prepareWorktreeBuiltIn,
  collectContextBuiltIn,
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

const defaultProviderBuiltInCatalog =
  createBuiltInStepCatalog(defaultBuiltInSteps);

export const builtInStepNames = defaultProviderBuiltInCatalog.names;
export const defaultProviderBuiltInStepRegistry =
  defaultProviderBuiltInCatalog.registry;
export const isBuiltInStepName =
  defaultProviderBuiltInCatalog.isBuiltInStepName;
export const runBuiltInStep = defaultProviderBuiltInCatalog.runBuiltInStep;
