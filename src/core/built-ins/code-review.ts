import { validateFindingEvidence as defaultValidateFindingEvidence } from "../evidence-validator.js";
import { prepare as defaultPrepareWorktree } from "../git-worktree-manager.js";
import { collectRepoContext as defaultCollectRepoContext } from "../repo-context-collector.js";
import {
  buildFinalReportJson as defaultBuildFinalReportJson,
  buildFinalReportMarkdown as defaultBuildFinalReportMarkdown
} from "../report-builder.js";
import { runPreflight as defaultRunPreflight } from "../preflight.js";
import type {
  AcceptanceDecision,
  CodeReviewFindings,
  Invocation,
  RepoContext,
  WorkspaceRecord
} from "../types.js";
import { defineBuiltInStep } from "./registry.js";
import {
  findingsFrom,
  githubPullRequestInvocationFrom,
  repositoryFrom,
  reportPathFrom,
  requiredInput,
  requiredState,
  resolvedInput,
  runIdFrom,
  workspaceFrom,
  workspaceRootFrom,
  workflowFrom,
  implementationFrom
} from "./state.js";

export const preflightBuiltIn = defineBuiltInStep({
  name: "preflight",
  async run({ state, dependencies = {} }) {
    const runPreflight = dependencies.runPreflight ?? defaultRunPreflight;

    return await runPreflight({
      invocation: requiredState(
        state.invocation as Invocation | undefined,
        "invocation"
      ),
      repository: repositoryFrom(state),
      workflow: workflowFrom(state),
      implementation: implementationFrom(state)
    });
  }
});

export const prepareWorktreeBuiltIn = defineBuiltInStep({
  name: "prepare_worktree",
  metadata: {
    capturesWorkspace: true,
    locks: [{ resource: "repository", mode: "exclusive" }]
  },
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

    return await collectRepoContext({
      invocation: githubPullRequestInvocationFrom(state),
      repository: {
        ...repositoryFrom(state),
        path: workspace.path
      }
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
  metadata: { deferUntilAfterWorkspaceLifecycle: true },
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
    const reportPath = reportPathFrom(state);

    return {
      json: buildFinalReportJson({
        acceptance,
        findings,
        reportPath,
        workspace: state.workspace as WorkspaceRecord | undefined
      }),
      markdown: buildFinalReportMarkdown({
        invocation: githubPullRequestInvocationFrom(state),
        findings,
        acceptance
      })
    };
  }
});
