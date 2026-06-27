import type { ObservabilitySummary } from "../observability/summary.js";
import type { WorkflowState } from "../workflow/state.js";

export type MaybePromise<T> = T | Promise<T>;

export type ImplementationLifecyclePhase =
  | "workspace"
  | "implementation"
  | "validation"
  | "diff"
  | "acceptance"
  | "commit"
  | "push"
  | "change_request";

export type ImplementationLifecycleOutcome = {
  readonly validationPassed?: boolean;
  readonly acceptanceAccepted?: boolean;
  readonly commitSucceeded?: boolean;
  readonly pushAttempted?: boolean;
  readonly changeRequestAttempted?: boolean;
};

export type BuiltInStepMetadata = {
  readonly deferredLifecycle?: "final_report";
  readonly implementationLifecycle?: ImplementationLifecyclePhase;
  readonly implementationLifecycleOutcome?: (
    output: unknown
  ) => ImplementationLifecycleOutcome | undefined;
  readonly capturesWorkspace?: boolean;
  readonly requiresRepository?: boolean;
  readonly locks?: readonly {
    readonly resource: "repository";
    readonly mode: "exclusive";
  }[];
};

export type BuiltInStepDependencies = Record<string, unknown>;

export type BuiltInStepRunOptions<
  Dependencies extends object = BuiltInStepDependencies
> = {
  readonly state: WorkflowState;
  readonly input?: Record<string, unknown>;
  readonly dependencies?: Dependencies;
  readonly observabilitySummary?: ObservabilitySummary;
};

export type BuiltInStep<
  Name extends string = string,
  Dependencies extends object = BuiltInStepDependencies
> = {
  readonly name: Name;
  readonly metadata?: BuiltInStepMetadata;
  readonly run: (options: BuiltInStepRunOptions<Dependencies>) => MaybePromise<unknown>;
};

export type BuiltInStepRegistryView = {
  readonly names?: readonly string[];
  require(name: string): { metadata?: BuiltInStepMetadata };
};

export type RunBuiltInStepOptions = BuiltInStepRunOptions & {
  uses: string;
};
