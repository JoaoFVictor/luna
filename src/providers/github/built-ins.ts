import { validateFindingEvidence as defaultValidateFindingEvidence } from "../../core/findings/evidence-validator.js";
import { prepare as defaultPrepareWorktree } from "./worktree-manager.js";
import { collectRepoContext as defaultCollectRepoContext } from "../../core/git/diff/repo-context.js";
import {
  buildFinalReportJson as defaultBuildFinalReportJson,
  buildFinalReportMarkdown as defaultBuildFinalReportMarkdown
} from "./report-builder.js";
import { runPreflight as defaultRunPreflight } from "../../core/preflight/runner.js";
import type { Invocation } from "../../core/router/invocation.js";
import type { RepoContext } from "../../core/git/diff/types.js";
import type {
  ImplementationConfig,
  WorkspaceRecord
} from "../../core/write-mode/types.js";
import type { RepositoryConfig } from "../../core/config/schemas.js";
import type {
  CodeReviewFindings
} from "../../core/findings/types.js";
import type { Finding } from "../../core/findings/types.js";
import type { AcceptanceDecision } from "../../core/decisions/types.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import {
  finalReportMetadata,
  prepareWorktreeMetadata,
  repositoryRequiredMetadata
} from "../../core/built-ins/metadata.js";
import {
  findingsFrom,
  repositoryFrom,
  requiredInput,
  requiredState,
  resolvedInput,
  runIdFrom,
  workspaceFrom,
  workspaceRootFrom,
  workflowFrom,
  implementationFrom
} from "../../core/built-ins/state.js";
import { builtInError } from "../../core/built-ins/errors.js";
import { githubPullRequestContextFrom } from "./pull-request-context.js";
import type {
  BuiltInStepDependencies,
  MaybePromise
} from "../../core/built-ins/types.js";

type GitHubBuiltInDependencies = BuiltInStepDependencies & {
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
  buildFinalReportJson?: (input: Parameters<typeof defaultBuildFinalReportJson>[0]) => unknown;
  buildFinalReportMarkdown?: (input: Parameters<typeof defaultBuildFinalReportMarkdown>[0]) => string;
};

function githubPullRequestInvocationFrom(state: { invocation?: unknown }): Invocation {
  const invocation = requiredState(
    state.invocation as Invocation | undefined,
    "invocation"
  );

  try {
    githubPullRequestContextFrom(invocation);
  } catch {
    throw builtInError(
      "Built-in step requires GitHub pull request invocation",
      "built_in_unsupported"
    );
  }

  return invocation;
}

export const preflightBuiltIn = defineBuiltInStep<
  "runtime.preflight",
  GitHubBuiltInDependencies
>({
  name: "runtime.preflight",
  metadata: repositoryRequiredMetadata,
  async run({ state, dependencies = {} }) {
    const runPreflight = dependencies.runPreflight ?? defaultRunPreflight;
    const invocation = requiredState(
      state.invocation as Invocation | undefined,
      "invocation"
    );

    return await runPreflight({
      invocation,
      repository: repositoryFrom(state),
      workflow: workflowFrom(state),
      implementation: implementationFrom(state)
    });
  }
});

export const prepareWorktreeBuiltIn = defineBuiltInStep<
  "runtime.prepare_worktree",
  GitHubBuiltInDependencies
>({
  name: "runtime.prepare_worktree",
  metadata: prepareWorktreeMetadata,
  async run({ state, dependencies = {} }) {
    const prepareWorktree = dependencies.prepareWorktree ?? defaultPrepareWorktree;

    return await prepareWorktree({
      invocation: githubPullRequestInvocationFrom(state),
      repository: repositoryFrom(state),
      workspaceRoot: workspaceRootFrom(state),
      runId: runIdFrom(state)
    });
  }
});

export const collectRepoContextBuiltIn = defineBuiltInStep<
  "runtime.collect_repo_context",
  GitHubBuiltInDependencies
>({
  name: "runtime.collect_repo_context",
  metadata: repositoryRequiredMetadata,
  async run({ state, dependencies = {} }) {
    const collectRepoContext =
      dependencies.collectRepoContext ?? defaultCollectRepoContext;
    const workspace = workspaceFrom(state);
    const invocation = githubPullRequestInvocationFrom(state);
    const pullRequest = githubPullRequestContextFrom(invocation);

    return await collectRepoContext({
      repository: {
        ...repositoryFrom(state),
        path: workspace.path
      },
      baseSha: pullRequest.references.base_sha,
      headSha: pullRequest.references.head_sha
    });
  }
});

export const validateCodeReviewFindingsBuiltIn = defineBuiltInStep<
  "runtime.validate_code_review_findings",
  GitHubBuiltInDependencies
>({
  name: "runtime.validate_code_review_findings",
  async run({ state, input, dependencies = {} }) {
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
});

export const finalCodeReviewReportBuiltIn = defineBuiltInStep<
  "runtime.final_code_review_report",
  GitHubBuiltInDependencies
>({
  name: "runtime.final_code_review_report",
  metadata: finalReportMetadata,
  async run({ state, input, dependencies = {}, observabilitySummary }) {
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
    const invocation = githubPullRequestInvocationFrom(state);

    return {
      json: buildFinalReportJson({
        acceptance,
        findings,
        workspace: state.workspace as WorkspaceRecord | undefined,
        ...(observabilitySummary === undefined
          ? {}
          : { summary: observabilitySummary })
      }),
      markdown: buildFinalReportMarkdown({
        invocation,
        findings,
        acceptance,
        ...(observabilitySummary === undefined
          ? {}
          : { summary: observabilitySummary })
      })
    };
  }
});
