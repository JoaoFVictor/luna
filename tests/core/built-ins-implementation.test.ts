import { describe, expect, it, vi } from "vitest";
import { prepareImplementationWorktreeBuiltIn } from "../../src/capabilities/repository-change/prepare-worktree-built-in.js";
import { recordImplementationValidationBuiltIn } from "../../src/capabilities/repository-change/validation-built-in.js";
import { prepareCommitBuiltIn } from "../../src/capabilities/repository-change/commit-built-ins.js";
import type { ApprovedWorktreeSnapshot } from "../../src/capabilities/git/worktree-snapshot.js";
import type { Invocation } from "../../src/core/router/invocation.js";
import type { WorkspaceRecord } from "../../src/capabilities/repository-change/types.js";
import type { RepositoryConfig } from "../../src/core/config/schemas.js";
import type {
  ImplementationConfig
} from "../../src/capabilities/repository-change/types.js";
import type { ImplementationWorktreeRecord } from "../../src/capabilities/repository-change/worktree.js";
import type { BuiltInStepRunOptions } from "../../src/core/built-ins/types.js";
import type { WorkflowState } from "../../src/core/workflow/state.js";

const jiraInvocation: Invocation = {
  version: "2026-06",
  source: "jira",
  event: "issue",
  action: "selected",
  repository: {
    provider: "github",
    owner: "octo-org",
    name: "hello-world"
  },
  subject: {
    type: "jira_issue",
    id: "ABC-123",
    url: "https://company.atlassian.net/browse/ABC-123",
    title: "Fix checkout validation"
  },
  payload: {
    jira: {
      instance_id: "company",
      description: "Reject invalid checkout payloads.",
      acceptance_criteria: "Invalid payloads fail validation.",
      status: "To Do",
      issue_type: "Task"
    }
  }
};

const repository: RepositoryConfig = {
  id: "repo",
  provider: "github",
  owner: "octo-org",
  name: "hello-world",
  path: "/repo",
  remote: "origin",
  expected_remote_urls: [
    "git@github.com:octo-org/hello-world.git",
    "https://github.com/octo-org/hello-world.git"
  ]
};

const workspace: WorkspaceRecord = {
  run_id: "run-123",
  path: "/worktree/repo",
  preserved: true,
  reason: "created"
};

const implementationWorkspace: ImplementationWorktreeRecord = {
  ...workspace,
  operation_id: "repository-workspace.capture",
  repository_id: "repo",
  workspace_id: "repo:run-123",
  lifecycle: "active",
  captured_at: "2026-06-25T10:00:00.000Z",
  remote: "origin",
  base_ref: "main",
  base_sha: "abc123",
  branch: "feature/abc-123-fix-checkout-validation"
};

const implementationConfig: ImplementationConfig["implementation"] = {
  branch_pattern: "feature/{slug}",
  commit: {
    enabled: true
  },
  push: {
    enabled: true,
    remote: "origin"
  },
  change_request: {
    enabled: true,
    provider: "github",
    draft: true,
    base_ref: "main"
  },
  sandbox: {
    type: "trusted_host_local"
  },
  validation: {
    repair_attempts: 1,
    max_output_bytes: 1000
  }
};

const approvedSnapshot: ApprovedWorktreeSnapshot = {
  kind: "git_worktree_tree.v1",
  head_sha: "a".repeat(40),
  tree_oid: "b".repeat(40),
  changed_paths: ["src/checkout.ts"]
};

function worktreeDiff(snapshot: ApprovedWorktreeSnapshot = approvedSnapshot) {
  return {
    files: [{
      path: "src/checkout.ts",
      status: "modified",
      index_status: " ",
      worktree_status: "M"
    }],
    untracked_files: [],
    untracked_summaries: [],
    staged_diff: "",
    unstaged_diff: "diff --git a/src/checkout.ts b/src/checkout.ts\n",
    staged_diff_truncated: false,
    unstaged_diff_truncated: false,
    max_diff_bytes: 65_536,
    status_files_omitted_count: 0,
    untracked_files_omitted_count: 0,
    untracked_summary_bytes: 0,
    max_untracked_summary_bytes: 65_536,
    approved_snapshot: snapshot
  } as const;
}

const accepted = {
  status: "accepted",
  summary: "Task satisfied.",
  blocking_reasons: [],
  recommended_action: "continue"
} as const;

function implementationState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    invocation: jiraInvocation,
    repository,
    run: { run_id: "run-123" },
    workspace: implementationWorkspace,
    workspaceRoot: "/tmp/worktrees",
    steps: {},
    config: {
      implementation: implementationConfig
    },
    ...overrides
  };
}

async function runBuiltIn(
  builtIn:
    | { run(options: BuiltInStepRunOptions): unknown }
    | ((options: BuiltInStepRunOptions) => unknown),
  options: BuiltInStepRunOptions
): Promise<unknown> {
  return await Promise.resolve().then(() =>
    typeof builtIn === "function" ? builtIn(options) : builtIn.run(options)
  );
}

describe("implementation built-ins", () => {
  it("runs prepare_implementation_worktree through injected dependencies", async () => {
    const prepareImplementationWorktree = vi.fn(async () => implementationWorkspace);

    await expect(
      prepareImplementationWorktreeBuiltIn.run({
        state: implementationState(),
        input: {
          subject: {
            key: "ABC-123",
            title: "Fix checkout validation"
          }
        },
        dependencies: { prepareImplementationWorktree }
      })
    ).resolves.toEqual(implementationWorkspace);

    expect(prepareImplementationWorktree).toHaveBeenCalledWith({
      subject: {
        key: "ABC-123",
        title: "Fix checkout validation"
      },
      repository,
      workspaceRoot: "/tmp/worktrees",
      runId: "run-123",
      baseRef: "main",
      branchPattern: "feature/{slug}"
    });
  });

  it("records rejected acceptance when the gated implementation worker fails", async () => {
    await expect(
      runBuiltIn(recordImplementationValidationBuiltIn, {
        state: implementationState(),
        input: {
          implementation: {
            status: "failed",
            attempts_exhausted: true,
            attempts: [
              {
                attempt: 1,
                phase: "initial",
                agent_error: {
                  message: "Pi runtime request timed out after 180000ms",
                  code: "runtime_provider_unavailable"
                }
              }
            ],
            validation: { passed: false },
            final_validation: { passed: false },
            gates: [],
            result: {
              status: "failed",
              agent_error: {
                message: "Pi runtime request timed out after 180000ms",
                code: "runtime_provider_unavailable"
              }
            }
          }
        }
      })
    ).resolves.toEqual({
      validation: { passed: false },
      acceptance: {
        status: "rejected",
        summary:
          "Implementation failed before acceptance review: Pi runtime request timed out after 180000ms",
        blocking_reasons: ["Pi runtime request timed out after 180000ms"],
        recommended_action: "stop"
      }
    });
  });

  it("persists the exact post-validation snapshot only when reviewed diff matches it", async () => {
    const implementation = {
      status: "passed",
      attempts_exhausted: false,
      attempts: [{
        attempt: 1,
        phase: "initial",
        validation: { passed: true },
        validated_snapshot: approvedSnapshot,
        gate_results: [],
        diff_summary: worktreeDiff()
      }],
      validation: { passed: true },
      final_validation: { passed: true },
      gates: [],
      result: {
        status: "passed",
        validated_snapshot: approvedSnapshot,
        diff_summary: worktreeDiff(),
        acceptance: accepted
      }
    };

    await expect(runBuiltIn(recordImplementationValidationBuiltIn, {
      state: implementationState(),
      input: { implementation }
    })).resolves.toEqual({
      validation: { passed: true },
      acceptance: accepted,
      approved_snapshot: approvedSnapshot
    });

    await expect(runBuiltIn(recordImplementationValidationBuiltIn, {
      state: implementationState(),
      input: {
        implementation: {
          ...implementation,
          result: {
            ...implementation.result,
            diff_summary: worktreeDiff({
              ...approvedSnapshot,
              tree_oid: "c".repeat(40)
            })
          }
        }
      }
    })).rejects.toThrow(
      "Passed implementation lacks one exact Git tree shared by validation and diff review."
    );
  });

  it("prepares a commit only for the exact validation-approved diff snapshot", async () => {
    const state = implementationState();
    await expect(runBuiltIn(prepareCommitBuiltIn, {
      state,
      input: {
        validation: { passed: true },
        acceptance: accepted,
        approved_snapshot: approvedSnapshot,
        diff: worktreeDiff(),
        message: "Fix checkout validation"
      }
    })).resolves.toMatchObject({
      operation_id: "git.commit",
      paths: ["src/checkout.ts"],
      expected_snapshot: approvedSnapshot
    });

    await expect(runBuiltIn(prepareCommitBuiltIn, {
      state,
      input: {
        validation: { passed: true },
        acceptance: accepted,
        approved_snapshot: approvedSnapshot,
        diff: worktreeDiff({ ...approvedSnapshot, tree_oid: "c".repeat(40) }),
        message: "Fix checkout validation"
      }
    })).rejects.toMatchObject({ code: "built_in_lifecycle_contract_invalid" });
  });

});
