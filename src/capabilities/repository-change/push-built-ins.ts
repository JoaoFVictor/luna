import type { CommitChangesArtifact, PushBranchArtifact } from "./types.js";
import type {
  GitPushBranchResult,
  GitPushBranchSkippedResult
} from "../git/contracts.js";
import { recordPushLifecycleMetadata } from "./metadata.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import {
  repositoryFrom,
  requiredInput,
  resolvedInput,
  stepValue
} from "../../core/built-ins/state.js";
import {
  expectedRemoteUrlsFrom,
  implementationWorkspaceFrom,
  requiredImplementationFrom
} from "./state.js";
import { lifecycleContractError, skipped } from "./shared.js";

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

export const preparePushBuiltIn = defineBuiltInStep({
  name: "repository-change.prepare_push",
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
  name: "repository-change.record_push_lifecycle",
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
