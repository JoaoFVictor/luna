import {
  prepareImplementationWorktree as defaultPrepareImplementationWorktree
} from "../implementation-worktree-manager.js";
import { safeJoin } from "../path-security.js";
import { runValidationCommands as defaultRunValidationCommands } from "../validation-runner.js";
import { collectWorktreeDiff as defaultCollectWorktreeDiff } from "../worktree-diff-collector.js";
import {
  commitChanges as defaultCommitChanges,
  pushBranch as defaultPushBranch
} from "../implementation-git-actions.js";
import { openChangeRequest as defaultOpenChangeRequest } from "../change-request-actions.js";
import type {
  AcceptanceDecision,
  CommitChangesArtifact,
  ChangeRequestArtifact,
  PushBranchArtifact,
  ValidationResult
} from "../types.js";
import {
  AcceptanceDecisionSchema,
  AgentLoopResultSchema,
  ChangeRequestArtifactSchema,
  CommitChangesArtifactSchema,
  PushBranchArtifactSchema,
  ValidationResultSchema
} from "../types.js";
import type { WorktreeDiff } from "../worktree-diff-collector.js";
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

type ImplementationSubject = {
  key: string;
  title?: string;
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

export const prepareImplementationWorktreeBuiltIn = defineBuiltInStep({
  name: "prepare_implementation_worktree",
  metadata: {
    implementationLifecycle: "workspace",
    capturesWorkspace: true,
    locks: [{ resource: "repository", mode: "exclusive" }]
  },
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

export const runValidationCommandsBuiltIn = defineBuiltInStep({
  name: "run_validation_commands",
  metadata: {
    implementationLifecycle: "validation",
    implementationLifecycleOutcome: (output) => {
      const result = ValidationResultSchema.safeParse(output);
      if (!result.success) {
        throw lifecycleContractError(
          "run_validation_commands must return ValidationResult"
        );
      }

      return {
        validationPassed: result.data.passed
      };
    }
  },
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
  name: "record_implementation_validation",
  metadata: {
    implementationLifecycle: "validation",
    implementationLifecycleOutcome: (output) => {
      const result = ValidationResultSchema.safeParse(output);
      if (!result.success) {
        throw lifecycleContractError(
          "record_implementation_validation must return ValidationResult"
        );
      }

      return {
        validationPassed: result.data.passed
      };
    }
  },
  run({ state, input }) {
    const resolved = resolvedInput(input, state);
    const implementation = AgentLoopResultSchema.parse(
      requiredInput(resolved.implementation, "implementation")
    );

    return implementation.final_validation;
  }
});

export const collectWorktreeDiffBuiltIn = defineBuiltInStep({
  name: "collect_worktree_diff",
  metadata: { implementationLifecycle: "diff" },
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
  name: "record_acceptance_decision",
  metadata: {
    implementationLifecycle: "acceptance",
    implementationLifecycleOutcome: (output) => {
      const result = AcceptanceDecisionSchema.safeParse(output);
      if (!result.success) {
        throw lifecycleContractError(
          "record_acceptance_decision must return AcceptanceDecision"
        );
      }

      return {
        acceptanceAccepted: result.data.status === "accepted"
      };
    }
  },
  run({ state, input }) {
    const resolved = resolvedInput(input, state);
    return requiredInput(resolved.acceptance, "acceptance");
  }
});

export const commitChangesBuiltIn = defineBuiltInStep({
  name: "commit_changes",
  metadata: {
    implementationLifecycle: "commit",
    implementationLifecycleOutcome: (output) => {
      const result = CommitChangesArtifactSchema.safeParse(output);
      if (!result.success) {
        throw lifecycleContractError("commit_changes must return CommitChangesArtifact");
      }

      return {
        commitSucceeded:
          !result.data.skipped && result.data.commit_sha !== undefined
      };
    },
    locks: [{ resource: "repository", mode: "exclusive" }]
  },
  async run({ state, input, dependencies = {} }) {
    const commitChanges = dependencies.commitChanges ?? defaultCommitChanges;
    const resolved = resolvedInput(input, state);
    const implementation = requiredImplementationFrom(state);
    const repository = repositoryFrom(state);
    const workspace = implementationWorkspaceFrom(state);
    const runId = runIdFrom(state);

    return await commitChanges({
      enabled: implementation.commit.enabled,
      cwd: workspace.path,
      validation: finalValidationFrom(state, resolved),
      acceptance: stepValue<AcceptanceDecision>(
        state,
        resolved,
        "acceptance",
        "acceptance"
      ),
      diff: stepValue<WorktreeDiff>(state, resolved, "diff", "worktree_diff"),
      branch: workspace.branch,
      remote: implementation.push.remote,
      baseSha: workspace.base_sha,
      branchPattern: implementation.branch_pattern,
      expectedRemoteUrls: expectedRemoteUrlsFrom(repository),
      message: requiredInput(resolved.message as string | undefined, "message"),
      runId,
      repositoryPath: repository.path,
      journalPath: await safeJoin(workspaceRootFrom(state), [
        repository.id,
        `${runId}.transactions.jsonl`
      ])
    });
  }
});

export const pushBranchBuiltIn = defineBuiltInStep({
  name: "push_branch",
  metadata: {
    implementationLifecycle: "push",
    implementationLifecycleOutcome: (output) => {
      const result = PushBranchArtifactSchema.safeParse(output);
      if (!result.success) {
        throw lifecycleContractError("push_branch must return PushBranchArtifact");
      }

      return {
        pushAttempted:
          !result.data.skipped &&
          result.data.remote !== undefined &&
          result.data.branch !== undefined
      };
    },
    locks: [{ resource: "repository", mode: "exclusive" }]
  },
  async run({ state, input, dependencies = {} }) {
    const pushBranch = dependencies.pushBranch ?? defaultPushBranch;
    const resolved = resolvedInput(input, state);
    const implementation = requiredImplementationFrom(state);
    const repository = repositoryFrom(state);
    const workspace = implementationWorkspaceFrom(state);

    return await pushBranch({
      enabled: implementation.push.enabled,
      cwd: workspace.path,
      commit: stepValue<CommitChangesArtifact>(state, resolved, "commit", "commit"),
      branch: workspace.branch,
      remote: implementation.push.remote,
      expectedRemoteUrls: expectedRemoteUrlsFrom(repository)
    });
  }
});

export const openChangeRequestBuiltIn = defineBuiltInStep({
  name: "open_change_request",
  metadata: {
    implementationLifecycle: "change_request",
    implementationLifecycleOutcome: (output) => {
      const result = ChangeRequestArtifactSchema.safeParse(output);
      if (!result.success) {
        throw lifecycleContractError(
          "open_change_request must return ChangeRequestArtifact"
        );
      }

      return {
        changeRequestAttempted:
          !result.data.skipped && result.data.url !== undefined
      };
    },
    locks: [{ resource: "repository", mode: "exclusive" }]
  },
  async run({ state, input, dependencies = {} }) {
    const openChangeRequest =
      dependencies.openChangeRequest ?? defaultOpenChangeRequest;
    const resolved = resolvedInput(input, state);
    const implementation = requiredImplementationFrom(state);
    const workspace = implementationWorkspaceFrom(state);

    return await openChangeRequest({
      enabled: implementation.change_request.enabled,
      provider: implementation.change_request.provider,
      cwd: workspace.path,
      push: stepValue<PushBranchArtifact>(state, resolved, "push", "push"),
      branch: workspace.branch,
      baseRef: implementation.change_request.base_ref,
      draft: implementation.change_request.draft,
      title: requiredInput(resolved.title as string | undefined, "title"),
      body: typeof resolved.body === "string" ? resolved.body : undefined
    });
  }
});
