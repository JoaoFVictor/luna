import {
  createLocalExecCommandBuiltIn,
  localExecPortsFromBuiltInOptions
} from "../local-exec/built-ins.js";
import {
  createGitCommitBuiltIn,
  createGitPushBranchBuiltIn,
  createGitStatusBuiltIn,
  gitPortsFromBuiltInOptions
} from "../git/built-ins.js";
import {
  changeRequestPortsFromBuiltInOptions,
  createChangeRequestCreateBuiltIn
} from "../change-request/built-ins.js";
import {
  createRepositoryWorkspaceCaptureBuiltIn,
  repositoryWorkspacePortsFromBuiltInOptions
} from "../repository-workspace/built-ins.js";
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
} from "./implementation.js";
import { collectContextBuiltIn } from "./context.js";
import { finalReportBuiltIn } from "../reports/final-report.js";
import { builtInError } from "./errors.js";
import { builtInStepMetadataByName } from "./metadata.js";
import { defineBuiltInRegistry } from "./registry.js";
import type {
  BuiltInStep,
  BuiltInStepMetadata,
  RunBuiltInStepOptions
} from "./types.js";

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

export const defaultBuiltInSteps = Object.freeze([
  collectContextBuiltIn,
  localExecReadCommandBuiltIn,
  localExecWriteCommandBuiltIn,
  repositoryWorkspaceCaptureBuiltIn,
  gitStatusBuiltIn,
  gitCommitBuiltIn,
  gitPushBranchBuiltIn,
  changeRequestCreateBuiltIn,
  prepareImplementationWorktreeBuiltIn,
  runValidationCommandsBuiltIn,
  recordImplementationValidationBuiltIn,
  collectWorktreeDiffBuiltIn,
  recordAcceptanceDecisionBuiltIn,
  prepareCommitBuiltIn,
  recordCommitLifecycleBuiltIn,
  preparePushBuiltIn,
  recordPushLifecycleBuiltIn,
  finalReportBuiltIn
] as const);

export function createBuiltInStepCatalog<
  const Steps extends readonly BuiltInStep[]
>(steps: Steps): {
  steps: Steps;
  names: readonly Steps[number]["name"][];
  registry: ReturnType<typeof defineBuiltInRegistry<Steps>>;
  isBuiltInStepName(value: string): value is Steps[number]["name"];
  runBuiltInStep(options: RunBuiltInStepOptions): Promise<unknown>;
} {
  const registry = defineBuiltInRegistry(steps);
  const nameSet: ReadonlySet<string> = new Set(registry.names);

  return Object.freeze({
    steps,
    names: registry.names,
    registry,
    isBuiltInStepName(value: string): value is Steps[number]["name"] {
      return nameSet.has(value);
    },
    async runBuiltInStep({
      uses,
      state,
      input,
      dependencies = {},
      observabilitySummary
    }: RunBuiltInStepOptions): Promise<unknown> {
      const builtIn = registry.require(uses);

      return await builtIn.run({
        state,
        input,
        dependencies,
        observabilitySummary
      });
    }
  });
}

export const defaultBuiltInCatalog = createBuiltInStepCatalog(defaultBuiltInSteps);

export type BuiltInStepName = keyof typeof builtInStepMetadataByName;

export const builtInStepNames = Object.freeze(
  Object.keys(builtInStepMetadataByName) as BuiltInStepName[]
);

const builtInStepNameSet: ReadonlySet<string> = new Set(builtInStepNames);

export function isBuiltInStepName(value: string): value is BuiltInStepName {
  return builtInStepNameSet.has(value);
}

export const builtInStepMetadataRegistry = Object.freeze({
  names: builtInStepNames,
  has(name: string): boolean {
    return isBuiltInStepName(name);
  },
  require(name: string): { metadata?: BuiltInStepMetadata } {
    if (!isBuiltInStepName(name)) {
      throw builtInError(
        `Unsupported built-in step: ${name}`,
        "built_in_unsupported"
      );
    }

    const metadata = builtInStepMetadataByName[name];
    return Object.keys(metadata).length === 0 ? {} : { metadata };
  }
});
