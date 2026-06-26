import type { Invocation } from "../router/invocation.js";
import type { RepoContext } from "../git/diff/types.js";
import type { WorkspaceRecord } from "../write-mode/types.js";
import type { RepositoryConfig } from "../config/schemas.js";
import type { Finding } from "../findings/types.js";
import type { AcceptanceDecision } from "../decisions/types.js";
import type { ValidationResult } from "../validation/runner.js";
import type {
  CommitChangesArtifact,
  ImplementationConfig,
  PushBranchArtifact
} from "../write-mode/types.js";
import type {
  ChangeRequestArtifact,
  ChangeRequestRegistry
} from "../change-request/contracts.js";
import type { ImplementationWorktreeRecord } from "../write-mode/worktree.js";
import type { WorktreeDiff } from "../git/diff/worktree-diff.js";
import type { ObservabilitySummary } from "../observability/summary.js";
import type { WorkflowState } from "../workflow/state.js";
import type { LocalExecCommandBuiltInPorts } from "../../capabilities/local-exec/contracts.js";
import type { RepositoryWorkspaceBuiltInPorts } from "../../capabilities/repository-workspace/contracts.js";
import type { GitBuiltInPorts } from "../../capabilities/git/contracts.js";

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

export type BuiltInStepRunOptions = {
  readonly state: WorkflowState;
  readonly input?: Record<string, unknown>;
  readonly dependencies?: BuiltInStepDependencies;
  readonly observabilitySummary?: ObservabilitySummary;
};

export type BuiltInStep<Name extends string = string> = {
  readonly name: Name;
  readonly metadata?: BuiltInStepMetadata;
  readonly run: (options: BuiltInStepRunOptions) => MaybePromise<unknown>;
};

export type BuiltInStepRegistryView = {
  readonly names?: readonly string[];
  require(name: string): { metadata?: BuiltInStepMetadata };
};

export type RunBuiltInStepOptions = BuiltInStepRunOptions & {
  uses: string;
};

export type BuiltInStepDependencies = {
  git?: GitBuiltInPorts;
  localExec?: LocalExecCommandBuiltInPorts;
  repositoryWorkspace?: RepositoryWorkspaceBuiltInPorts;
  runPreflight?: (input: {
    invocation: Invocation;
    repository: RepositoryConfig;
    workflow?: { mode: "read_only" | "trusted_local_write" };
    implementation?: ImplementationConfig["implementation"];
  }) => MaybePromise<unknown>;
  prepareWorktree?: (input: {
    invocation: Invocation;
    repository: RepositoryConfig;
    workspaceRoot: string;
    runId: string;
  }) => MaybePromise<WorkspaceRecord>;
  collectRepoContext?: (input: {
    repository: RepositoryConfig;
    baseSha: string;
    headSha: string;
  }) => MaybePromise<RepoContext>;
  validateFindingEvidence?: (
    repoContext: RepoContext,
    findings: readonly Finding[]
  ) => Finding[];
  buildFinalReportJson?: (input: {
    acceptance: AcceptanceDecision;
    findings: readonly Finding[];
    workspace?: WorkspaceRecord;
    summary?: ObservabilitySummary;
  }) => unknown;
  buildFinalReportMarkdown?: (input: {
    invocation: Invocation;
    findings: readonly Finding[];
    acceptance: AcceptanceDecision;
    summary?: ObservabilitySummary;
  }) => string;
  prepareImplementationWorktree?: (input: {
    subject: {
      key: string;
      title?: string;
    };
    repository: RepositoryConfig;
    workspaceRoot: string;
    runId: string;
    baseRef: string;
    branchPattern: string;
  }) => MaybePromise<ImplementationWorktreeRecord>;
  runValidationCommands?: (input: {
    cwd: string;
    commands: ImplementationConfig["implementation"]["validation"]["commands"];
    maxOutputBytes: number;
  }) => MaybePromise<ValidationResult>;
  collectWorktreeDiff?: (input: {
    cwd: string;
    maxDiffBytes: number;
  }) => MaybePromise<WorktreeDiff>;
  commitChanges?: (input: {
    enabled: boolean;
    cwd: string;
    validation: ValidationResult;
    acceptance: AcceptanceDecision;
    diff: WorktreeDiff;
    branch: string;
    remote: string;
    baseSha: string;
    branchPattern: string;
    expectedRemoteUrls: readonly string[];
    message: string;
    runId?: string;
    repositoryPath?: string;
    journalPath?: string;
  }) => MaybePromise<CommitChangesArtifact>;
  pushBranch?: (input: {
    enabled: boolean;
    cwd: string;
    commit: CommitChangesArtifact;
    branch: string;
    remote: string;
    expectedRemoteUrls: readonly string[];
  }) => MaybePromise<PushBranchArtifact>;
  changeRequestRegistry?: ChangeRequestRegistry;
  buildImplementationReportJson?: (input: {
    invocation: Invocation;
    status: string;
    branch: string;
    worktree: {
      path: string;
      preserved: boolean;
      reason: string;
    };
    validation: ValidationResult;
    commit: CommitChangesArtifact;
    push: PushBranchArtifact;
    changeRequest: ChangeRequestArtifact;
    trustedHostLocal: boolean;
    summary?: ObservabilitySummary;
  }) => unknown;
  buildImplementationReportMarkdown?: (input: {
    invocation: Invocation;
    status: string;
    branch: string;
    worktree: {
      path: string;
      preserved: boolean;
      reason: string;
    };
    validation: ValidationResult;
    commit: CommitChangesArtifact;
    push: PushBranchArtifact;
    changeRequest: ChangeRequestArtifact;
    trustedHostLocal: boolean;
    summary?: ObservabilitySummary;
  }) => string;
};
