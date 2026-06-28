import type { AcceptanceDecision } from "../../core/decisions/types.js";
import type { CommitChangesArtifact } from "./types.js";
import type {
  GitCommitResult,
  GitCommitSkippedResult
} from "../git/contracts.js";
import type { WorktreeDiff } from "../git/diff/worktree-diff.js";
import { recordCommitLifecycleMetadata } from "./metadata.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import {
  repositoryFrom,
  requiredInput,
  resolvedInput,
  stepValue
} from "../../core/built-ins/state.js";
import {
  expectedRemoteUrlsFrom,
  finalValidationFrom,
  implementationWorkspaceFrom,
  requiredImplementationFrom
} from "./state.js";
import {
  hasDiff,
  isAccepted,
  lifecycleContractError,
  skipped,
  stageablePaths
} from "./shared.js";

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

export const prepareCommitBuiltIn = defineBuiltInStep({
  name: "repository-change.prepare_commit",
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
  name: "repository-change.record_commit_lifecycle",
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
