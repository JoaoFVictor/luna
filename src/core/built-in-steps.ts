import {
  buildFinalReportJson as defaultBuildFinalReportJson,
  buildFinalReportMarkdown as defaultBuildFinalReportMarkdown
} from "./report-builder.js";
import { prepare as defaultPrepareWorktree } from "./git-worktree-manager.js";
import { collectRepoContext as defaultCollectRepoContext } from "./repo-context-collector.js";
import { runPreflight as defaultRunPreflight } from "./preflight.js";
import { validateFindingEvidence as defaultValidateFindingEvidence } from "./evidence-validator.js";
import { resolveWorkflowInput, type WorkflowState } from "./workflow-state.js";
import type {
  AcceptanceDecision,
  CodeReviewFindings,
  Finding,
  GithubPrInvocation,
  Invocation,
  RepoContext,
  RepositoryConfig,
  WorkspaceRecord
} from "./types.js";

export type BuiltInStepName =
  | "preflight"
  | "prepare_worktree"
  | "collect_repo_context"
  | "validate_code_review_findings"
  | "final_code_review_report"
  | "prepare_implementation_worktree"
  | "collect_task_context"
  | "run_validation_commands"
  | "collect_worktree_diff"
  | "commit_changes"
  | "push_branch"
  | "open_pull_request"
  | "final_implementation_report";

type MaybePromise<T> = T | Promise<T>;

export type BuiltInStepDependencies = {
  runPreflight?: (input: {
    invocation: GithubPrInvocation;
    repository: RepositoryConfig;
  }) => MaybePromise<unknown>;
  prepareWorktree?: (input: {
    invocation: GithubPrInvocation;
    repository: RepositoryConfig;
    workspaceRoot: string;
    runId: string;
  }) => MaybePromise<WorkspaceRecord>;
  collectRepoContext?: (input: {
    invocation: GithubPrInvocation;
    repository: RepositoryConfig;
  }) => MaybePromise<RepoContext>;
  validateFindingEvidence?: (
    repoContext: RepoContext,
    findings: readonly Finding[]
  ) => Finding[];
  buildFinalReportJson?: (input: {
    acceptance: AcceptanceDecision;
    findings: readonly Finding[];
    reportPath: string;
    workspace?: WorkspaceRecord;
  }) => unknown;
  buildFinalReportMarkdown?: (input: {
    invocation: GithubPrInvocation;
    findings: readonly Finding[];
    acceptance: AcceptanceDecision;
  }) => string;
};

export type RunBuiltInStepOptions = {
  uses: BuiltInStepName;
  state: WorkflowState;
  input?: Record<string, unknown>;
  dependencies?: BuiltInStepDependencies;
};

type BuiltInErrorCode =
  | "built_in_input_missing"
  | "built_in_state_missing"
  | "built_in_unsupported";

function builtInError(message: string, code: BuiltInErrorCode): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;

  return error;
}

function requiredState<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw builtInError(`Built-in step requires state.${name}`, "built_in_state_missing");
  }

  return value;
}

function requiredInput<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw builtInError(`Built-in step requires input.${name}`, "built_in_input_missing");
  }

  return value;
}

function asRecord(value: unknown, name: string, code: BuiltInErrorCode): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw builtInError(`Built-in step requires ${name}`, code);
  }

  return value as Record<string, unknown>;
}

function githubPrInvocationFrom(state: WorkflowState): GithubPrInvocation {
  const invocation = requiredState(
    state.invocation as Invocation | undefined,
    "invocation"
  );

  if (invocation.target !== "github_pr") {
    throw builtInError(
      `Built-in step requires github_pr invocation: ${invocation.target}`,
      "built_in_unsupported"
    );
  }

  return invocation;
}

function repositoryFrom(state: WorkflowState): RepositoryConfig {
  return requiredState(state.repository as RepositoryConfig | undefined, "repository");
}

function runIdFrom(state: WorkflowState): string {
  const run = asRecord(requiredState(state.run, "run"), "state.run", "built_in_state_missing");
  return requiredState(run.run_id as string | undefined, "run.run_id");
}

function workspaceFrom(state: WorkflowState): WorkspaceRecord {
  return requiredState(state.workspace as WorkspaceRecord | undefined, "workspace");
}

function workspaceRootFrom(state: WorkflowState): string {
  return requiredState(state.workspaceRoot, "workspaceRoot");
}

function reportPathFrom(state: WorkflowState): string {
  return requiredState(state.reportPath, "reportPath");
}

function findingsFrom(value: unknown): readonly Finding[] {
  if (Array.isArray(value)) {
    return value as Finding[];
  }

  return requiredInput((value as CodeReviewFindings | undefined)?.findings, "findings.findings");
}

function resolvedInput(
  input: Record<string, unknown> | undefined,
  state: WorkflowState
): Record<string, unknown> {
  return resolveWorkflowInput(input, state);
}

export async function runBuiltInStep({
  uses,
  state,
  input,
  dependencies = {}
}: RunBuiltInStepOptions): Promise<unknown> {
  if (uses === "preflight") {
    const runPreflight = dependencies.runPreflight ?? defaultRunPreflight;

    return await runPreflight({
      invocation: githubPrInvocationFrom(state),
      repository: repositoryFrom(state)
    });
  }

  if (uses === "prepare_worktree") {
    const prepareWorktree = dependencies.prepareWorktree ?? defaultPrepareWorktree;
    const runId = runIdFrom(state);

    return await prepareWorktree({
      invocation: githubPrInvocationFrom(state),
      repository: repositoryFrom(state),
      workspaceRoot: workspaceRootFrom(state),
      runId
    });
  }

  if (uses === "collect_repo_context") {
    const collectRepoContext = dependencies.collectRepoContext ?? defaultCollectRepoContext;
    const workspace = workspaceFrom(state);

    return await collectRepoContext({
      invocation: githubPrInvocationFrom(state),
      repository: {
        ...repositoryFrom(state),
        path: workspace.path
      }
    });
  }

  if (uses === "validate_code_review_findings") {
    const validateFindingEvidence =
      dependencies.validateFindingEvidence ?? defaultValidateFindingEvidence;
    const resolved = resolvedInput(input, state);
    const repoContext = requiredInput(
      resolved.repo_context as RepoContext | undefined,
      "repo_context"
    );
    const findingsPayload = requiredInput(resolved.findings, "findings");
    const findings = findingsFrom(findingsPayload);

    return {
      ...(typeof findingsPayload === "object" &&
      findingsPayload !== null &&
      !Array.isArray(findingsPayload) &&
      typeof (findingsPayload as CodeReviewFindings).summary === "string"
        ? { summary: (findingsPayload as CodeReviewFindings).summary }
        : {}),
      findings: validateFindingEvidence(repoContext, findings)
    };
  }

  if (uses === "final_code_review_report") {
    const buildFinalReportJson =
      dependencies.buildFinalReportJson ?? defaultBuildFinalReportJson;
    const buildFinalReportMarkdown =
      dependencies.buildFinalReportMarkdown ?? defaultBuildFinalReportMarkdown;
    const resolved = resolvedInput(input, state);
    const findings = findingsFrom(requiredInput(resolved.findings, "findings"));
    const acceptance = requiredInput(
      resolved.acceptance as AcceptanceDecision | undefined,
      "acceptance"
    );
    const reportPath = reportPathFrom(state);

    return {
      json: buildFinalReportJson({
        acceptance,
        findings,
        reportPath,
        workspace: state.workspace as WorkspaceRecord | undefined
      }),
      markdown: buildFinalReportMarkdown({
        invocation: githubPrInvocationFrom(state),
        findings,
        acceptance
      })
    };
  }

  throw builtInError(`Unsupported built-in step: ${uses}`, "built_in_unsupported");
}
