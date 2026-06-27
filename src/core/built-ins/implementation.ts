import {
  prepareImplementationWorktree as defaultPrepareImplementationWorktree
} from "../write-mode/worktree.js";
import { runValidationCommands as defaultRunValidationCommands } from "../validation/runner.js";
import { collectWorktreeDiff as defaultCollectWorktreeDiff } from "../git/diff/worktree-diff.js";
import type { AcceptanceDecision } from "../decisions/types.js";
import { GatedAgentLoopResultSchema } from "../agent-runtime/contracts.js";
import type {
  ImplementationConfig,
  CommitChangesArtifact,
  PushBranchArtifact
} from "../write-mode/types.js";
import type { WorktreeDiff } from "../git/diff/worktree-diff.js";
import type { RepositoryConfig } from "../config/schemas.js";
import type { ValidationResult } from "../validation/runner.js";
import type { ImplementationWorktreeRecord } from "../write-mode/worktree.js";
import type {
  GitCommitResult,
  GitCommitSkippedResult,
  GitPushBranchResult,
  GitPushBranchSkippedResult
} from "../git/contracts.js";
import {
  collectWorktreeDiffMetadata,
  prepareImplementationWorktreeMetadata,
  recordAcceptanceDecisionMetadata,
  recordCommitLifecycleMetadata,
  recordImplementationValidationMetadata,
  recordPushLifecycleMetadata,
  runValidationCommandsMetadata
} from "./metadata.js";
import { AcceptanceDecisionSchema } from "../decisions/types.js";
import { defineBuiltInStep } from "./registry.js";
import {
  expectedRemoteUrlsFrom,
  finalValidationFrom,
  implementationWorkspaceFrom,
  repositoryFrom,
  requiredImplementationFrom,
  requiredInput,
  resolvedInput,
  runIdFrom,
  stepValue,
  workspaceFrom,
  workspaceRootFrom
} from "./state.js";
import type { BuiltInStepDependencies, MaybePromise } from "./types.js";

type ImplementationSubject = {
  key: string;
  title?: string;
};

type ImplementationBuiltInDependencies = BuiltInStepDependencies & {
  prepareImplementationWorktree?: (input: {
    subject: ImplementationSubject;
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
};

function lifecycleContractError(message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = "built_in_lifecycle_contract_invalid";

  return error;
}

function implementationSubjectFrom(input: unknown): ImplementationSubject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw lifecycleContractError("Implementation subject must be an object");
  }

  const subject = input as { key?: unknown; title?: unknown };
  if (typeof subject.key !== "string" || subject.key === "") {
    throw lifecycleContractError("Implementation subject key is required");
  }

  if (subject.title !== undefined && typeof subject.title !== "string") {
    throw lifecycleContractError("Implementation subject title must be a string");
  }

  return {
    key: subject.key,
    ...(subject.title === undefined ? {} : { title: subject.title })
  };
}

function skipped(
  enabled: boolean,
  reason: string
): { enabled: boolean; skipped: true; reason: string } {
  return { enabled, skipped: true, reason };
}

function isAccepted(acceptance: AcceptanceDecision): boolean {
  return acceptance.status === "accepted";
}

function fallbackRejectedAcceptance(implementation: { readonly result: unknown }): AcceptanceDecision {
  const message = agentErrorMessage(implementation.result) ??
    "Implementation did not produce a reviewable result.";

  return {
    status: "rejected",
    summary: `Implementation failed before acceptance review: ${message}`,
    blocking_reasons: [message],
    recommended_action: "stop"
  };
}

function agentErrorMessage(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return undefined;
  }

  const agentError = (result as { agent_error?: unknown }).agent_error;
  if (typeof agentError !== "object" || agentError === null || Array.isArray(agentError)) {
    return undefined;
  }

  const message = (agentError as { message?: unknown }).message;
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

function hasDiff(diff: WorktreeDiff): boolean {
  return (
    diff.files.length > 0 ||
    diff.untracked_files.length > 0 ||
    diff.staged_diff.trim() !== "" ||
    diff.unstaged_diff.trim() !== ""
  );
}

function stageablePaths(diff: WorktreeDiff): string[] {
  const paths: string[] = [];

  for (const file of diff.files) {
    if (file.status === "untracked") {
      if (file.untracked_summary?.omitted_reason === "sensitive_path") {
        continue;
      }

      paths.push(file.path);
      continue;
    }

    paths.push(file.path);
  }

  return [...new Set(paths)];
}

function isGitCommitSkipped(value: unknown): value is GitCommitSkippedResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { operation_id?: unknown }).operation_id === "git.commit" &&
    (value as { skipped?: unknown }).skipped === true
  );
}

function isGitCommitResult(value: unknown): value is GitCommitResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { operation_id?: unknown }).operation_id === "git.commit" &&
    typeof (value as { commit_sha?: unknown }).commit_sha === "string" &&
    typeof (value as { branch?: unknown }).branch === "string"
  );
}

function isGitPushSkipped(value: unknown): value is GitPushBranchSkippedResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { operation_id?: unknown }).operation_id === "git.push_branch" &&
    (value as { skipped?: unknown }).skipped === true
  );
}

function isGitPushResult(value: unknown): value is GitPushBranchResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { operation_id?: unknown }).operation_id === "git.push_branch" &&
    typeof (value as { remote?: unknown }).remote === "string" &&
    typeof (value as { branch?: unknown }).branch === "string"
  );
}

export const prepareImplementationWorktreeBuiltIn = defineBuiltInStep<
  "runtime.prepare_implementation_worktree",
  ImplementationBuiltInDependencies
>({
  name: "runtime.prepare_implementation_worktree",
  metadata: prepareImplementationWorktreeMetadata,
  async run({ state, input, dependencies = {} }) {
    const prepareImplementationWorktree =
      dependencies.prepareImplementationWorktree ??
      defaultPrepareImplementationWorktree;
    const implementation = requiredImplementationFrom(state);
    const resolved = resolvedInput(input, state);

    return await prepareImplementationWorktree({
      subject: implementationSubjectFrom(requiredInput(resolved.subject, "subject")),
      repository: repositoryFrom(state),
      workspaceRoot: workspaceRootFrom(state),
      runId: runIdFrom(state),
      baseRef: implementation.change_request.base_ref,
      branchPattern: implementation.branch_pattern
    });
  }
});

export const runValidationCommandsBuiltIn = defineBuiltInStep<
  "runtime.run_validation_commands",
  ImplementationBuiltInDependencies
>({
  name: "runtime.run_validation_commands",
  metadata: runValidationCommandsMetadata,
  async run({ state, dependencies = {} }) {
    const runValidationCommands =
      dependencies.runValidationCommands ?? defaultRunValidationCommands;
    const implementation = requiredImplementationFrom(state);

    return await runValidationCommands({
      cwd: workspaceFrom(state).path,
      commands: implementation.validation.commands,
      maxOutputBytes: implementation.validation.max_output_bytes
    });
  }
});

export const recordImplementationValidationBuiltIn = defineBuiltInStep({
  name: "runtime.record_implementation_validation",
  metadata: recordImplementationValidationMetadata,
  run({ state, input }) {
    const resolved = resolvedInput(input, state);
    const implementation = GatedAgentLoopResultSchema.parse(
      requiredInput(resolved.implementation, "implementation")
    );
    const acceptance =
      implementation.result.acceptance === undefined
        ? fallbackRejectedAcceptance(implementation)
        : AcceptanceDecisionSchema.parse(implementation.result.acceptance);

    return {
      validation: implementation.final_validation,
      acceptance
    };
  }
});

export const collectWorktreeDiffBuiltIn = defineBuiltInStep<
  "runtime.collect_worktree_diff",
  ImplementationBuiltInDependencies
>({
  name: "runtime.collect_worktree_diff",
  metadata: collectWorktreeDiffMetadata,
  async run({ state, dependencies = {} }) {
    const collectWorktreeDiff =
      dependencies.collectWorktreeDiff ?? defaultCollectWorktreeDiff;
    const implementation = requiredImplementationFrom(state);

    return await collectWorktreeDiff({
      cwd: workspaceFrom(state).path,
      maxDiffBytes: implementation.validation.max_output_bytes
    });
  }
});

export const recordAcceptanceDecisionBuiltIn = defineBuiltInStep({
  name: "runtime.record_acceptance_decision",
  metadata: recordAcceptanceDecisionMetadata,
  run({ state, input }) {
    const resolved = resolvedInput(input, state);
    return requiredInput(resolved.acceptance, "acceptance");
  }
});

export const prepareCommitBuiltIn = defineBuiltInStep({
  name: "runtime.prepare_commit",
  run({ state, input }) {
    const resolved = resolvedInput(input, state);
    const implementation = requiredImplementationFrom(state);
    const repository = repositoryFrom(state);
    const workspace = implementationWorkspaceFrom(state);
    const validation = finalValidationFrom(state, resolved);
    const acceptance = stepValue<AcceptanceDecision>(
      state,
      resolved,
      "acceptance",
      "acceptance"
    );
    const diff = stepValue<WorktreeDiff>(state, resolved, "diff", "worktree_diff");
    const message = requiredInput(
      resolved.message as string | undefined,
      "message"
    );

    if (!implementation.commit.enabled) {
      return skipped(false, "disabled");
    }

    if (!validation.passed) {
      return skipped(true, "validation_failed");
    }

    if (!isAccepted(acceptance)) {
      return skipped(true, "acceptance_rejected");
    }

    if (!hasDiff(diff)) {
      return skipped(true, "empty_diff");
    }

    const paths = stageablePaths(diff);
    if (paths.length === 0) {
      return skipped(true, "sensitive_untracked_files");
    }

    return {
      operation_id: "git.commit",
      message,
      paths,
      expected_branch: workspace.branch,
      expected_base_sha: workspace.base_sha,
      remote: implementation.push.remote,
      expected_remote_urls: expectedRemoteUrlsFrom(repository)
    };
  }
});

export const recordCommitLifecycleBuiltIn = defineBuiltInStep({
  name: "runtime.record_commit_lifecycle",
  metadata: recordCommitLifecycleMetadata,
  run({ input }) {
    const commit = requiredInput(input?.commit, "commit");

    if (isGitCommitSkipped(commit)) {
      return {
        enabled: commit.enabled,
        skipped: true,
        reason: commit.reason
      } satisfies CommitChangesArtifact;
    }

    if (!isGitCommitResult(commit)) {
      throw lifecycleContractError("record_commit_lifecycle requires git.commit output");
    }

    return {
      enabled: true,
      skipped: false,
      branch: commit.branch,
      commit_sha: commit.commit_sha
    } satisfies CommitChangesArtifact;
  }
});

export const preparePushBuiltIn = defineBuiltInStep({
  name: "runtime.prepare_push",
  run({ state, input }) {
    const resolved = resolvedInput(input, state);
    const implementation = requiredImplementationFrom(state);
    const repository = repositoryFrom(state);
    const workspace = implementationWorkspaceFrom(state);
    const commit = stepValue<CommitChangesArtifact>(
      state,
      resolved,
      "commit",
      "commit_lifecycle"
    );

    if (!implementation.push.enabled) {
      return skipped(false, "disabled");
    }

    if (commit.skipped || commit.commit_sha === undefined) {
      return skipped(true, "no_commit");
    }

    if (commit.branch !== workspace.branch) {
      return skipped(true, "branch_mismatch");
    }

    return {
      operation_id: "git.push_branch",
      branch: workspace.branch,
      remote: implementation.push.remote,
      expected_commit_sha: commit.commit_sha,
      expected_remote_urls: expectedRemoteUrlsFrom(repository)
    };
  }
});

export const recordPushLifecycleBuiltIn = defineBuiltInStep({
  name: "runtime.record_push_lifecycle",
  metadata: recordPushLifecycleMetadata,
  run({ input }) {
    const push = requiredInput(input?.push, "push");

    if (isGitPushSkipped(push)) {
      return {
        enabled: push.enabled,
        skipped: true,
        reason: push.reason
      } satisfies PushBranchArtifact;
    }

    if (!isGitPushResult(push)) {
      throw lifecycleContractError("record_push_lifecycle requires git.push_branch output");
    }

    return {
      enabled: true,
      skipped: false,
      remote: push.remote,
      branch: push.branch
    } satisfies PushBranchArtifact;
  }
});
