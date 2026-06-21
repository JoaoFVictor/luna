import { validateFindingEvidence as defaultValidateFindingEvidence } from "../../findings/evidence-validator.js";
import { prepare as defaultPrepareWorktree } from "./worktree-manager.js";
import { collectRepoContext as defaultCollectRepoContext } from "../../git/diff/repo-context.js";
import {
  buildFinalReportJson as defaultBuildFinalReportJson,
  buildFinalReportMarkdown as defaultBuildFinalReportMarkdown
} from "./report-builder.js";
import { runPreflight as defaultRunPreflight } from "../../preflight/runner.js";
import type { Invocation } from "../../invocation/types.js";
import type { RepoContext } from "../../git/diff/types.js";
import type { WorkspaceRecord } from "../../write-mode/types.js";
import type {
  CodeReviewFindings
} from "../../findings/types.js";
import type { AcceptanceDecision } from "../../decisions/types.js";
import { defineBuiltInStep } from "../../built-ins/registry.js";
import {
  finalReportMetadata,
  prepareWorktreeMetadata
} from "../../built-ins/metadata.js";
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
} from "../../built-ins/state.js";
import { builtInError } from "../../built-ins/errors.js";
import { githubPullRequestContextFrom } from "./pull-request-context.js";

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

export const preflightBuiltIn = defineBuiltInStep({
  name: "preflight",
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

export const prepareWorktreeBuiltIn = defineBuiltInStep({
  name: "prepare_worktree",
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

export const collectRepoContextBuiltIn = defineBuiltInStep({
  name: "collect_repo_context",
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

export const validateCodeReviewFindingsBuiltIn = defineBuiltInStep({
  name: "validate_code_review_findings",
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

export const finalCodeReviewReportBuiltIn = defineBuiltInStep({
  name: "final_code_review_report",
  metadata: finalReportMetadata,
  async run({ state, input, dependencies = {} }) {
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
        workspace: state.workspace as WorkspaceRecord | undefined
      }),
      markdown: buildFinalReportMarkdown({
        invocation,
        findings,
        acceptance
      })
    };
  }
});
