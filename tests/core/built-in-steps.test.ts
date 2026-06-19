import { describe, expect, it, vi } from "vitest";
import { runBuiltInStep } from "../../src/core/built-in-steps.js";
import type {
  AcceptanceDecision,
  CommitChangesArtifact,
  Finding,
  ImplementationConfig,
  Invocation,
  JiraTaskInvocation,
  PullRequestArtifact,
  PushBranchArtifact,
  RepoContext,
  RepositoryConfig,
  ValidationResult,
  WorkspaceRecord
} from "../../src/core/types.js";
import type { ImplementationWorktreeRecord } from "../../src/core/implementation-worktree-manager.js";
import type { WorktreeDiff } from "../../src/core/worktree-diff-collector.js";
import type { WorkflowState } from "../../src/core/workflow-state.js";

const invocation: Invocation = {
  target: "github_pr",
  owner: "octo-org",
  repo: "hello-world",
  pull_number: 42,
  base_ref: "main",
  base_repository: {
    owner: "octo-org",
    name: "hello-world",
    full_name: "octo-org/hello-world"
  },
  head_repository: {
    owner: "contributor",
    name: "hello-world",
    full_name: "contributor/hello-world",
    fork: true
  },
  references: {
    base_sha: "abc123",
    head_sha: "def456"
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

const jiraInvocation: JiraTaskInvocation = {
  target: "jira_task",
  workflow: "implementation",
  jira: {
    instance_id: "company",
    issue_key: "ABC-123",
    url: "https://company.atlassian.net/browse/ABC-123",
    summary: "Fix checkout validation",
    description: "Reject invalid checkout payloads.",
    acceptance_criteria: "Invalid payloads fail validation.",
    status: "To Do",
    issue_type: "Task"
  },
  repository: {
    provider: "github",
    owner: "swinggo-dev",
    name: "swg-front-nuxt"
  }
};

const workspace: WorkspaceRecord = {
  run_id: "run-123",
  path: "/worktree/repo",
  preserved: true,
  reason: "created"
};

const implementationWorkspace: ImplementationWorktreeRecord = {
  ...workspace,
  repository_id: "repo",
  remote: "origin",
  base_ref: "main",
  base_sha: "abc123",
  branch: "feature/abc-123-fix-checkout-validation"
};

const repoContext: RepoContext = {
  repository: {
    owner: "octo-org",
    name: "hello-world",
    full_name: "octo-org/hello-world"
  },
  base_sha: "abc123",
  head_sha: "def456",
  files: []
};

const finding: Finding = {
  title: "Issue",
  severity: "high",
  confidence: "high",
  description: "Issue description.",
  evidence: [
    {
      path: "src/index.ts",
      line_start: 1,
      line_end: 1
    }
  ],
  recommendation: "Fix it."
};

const acceptance: AcceptanceDecision = {
  status: "rejected",
  summary: "One issue remains.",
  blocking_reasons: ["Issue"],
  recommended_action: "request_changes"
};

const acceptedImplementation = {
  status: "accepted"
};

const validation: ValidationResult = {
  passed: true,
  commands: [
    {
      cmd: "npm",
      args: ["test"],
      exit_code: 0,
      stdout: "",
      stderr: "",
      stdout_truncated: false,
      stderr_truncated: false,
      duration_ms: 25,
      timed_out: false
    }
  ]
};

const failedValidation: ValidationResult = {
  ...validation,
  passed: false,
  commands: [
    {
      ...validation.commands![0],
      exit_code: 1,
      stderr: "failed"
    }
  ]
};

const worktreeDiff: WorktreeDiff = {
  files: [
    {
      path: "src/checkout.ts",
      status: "modified",
      index_status: " ",
      worktree_status: "M"
    }
  ],
  untracked_files: [],
  untracked_summaries: [],
  staged_diff: "",
  unstaged_diff: "diff --git a/src/checkout.ts b/src/checkout.ts\n+fix\n",
  staged_diff_truncated: false,
  unstaged_diff_truncated: false,
  max_diff_bytes: 1000
};

const commitArtifact: CommitChangesArtifact = {
  enabled: true,
  skipped: false,
  branch: implementationWorkspace.branch,
  commit_sha: "2222222222222222222222222222222222222222"
};

const skippedCommitArtifact: CommitChangesArtifact = {
  enabled: false,
  skipped: true,
  reason: "disabled"
};

const pushArtifact: PushBranchArtifact = {
  enabled: true,
  skipped: false,
  remote: "origin",
  branch: implementationWorkspace.branch
};

const pullRequestArtifact: PullRequestArtifact = {
  enabled: true,
  skipped: false,
  provider: "github",
  url: "https://github.com/swinggo-dev/swg-front-nuxt/pull/42"
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
  pull_request: {
    enabled: true,
    provider: "github",
    draft: true,
    base_ref: "main"
  },
  sandbox: {
    type: "trusted_host_local",
    env_allowlist: []
  },
  validation: {
    repair_attempts: 1,
    max_output_bytes: 1000,
    commands: [
      {
        cmd: "npm",
        args: ["test"]
      }
    ]
  }
};

function workflowState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    invocation,
    repository,
    run: { run_id: "run-123" },
    workspace,
    workspaceRoot: "/tmp/worktrees",
    reportPath: "/tmp/report.md",
    steps: {},
    ...overrides
  };
}

function implementationState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return workflowState({
    invocation: jiraInvocation,
    repository,
    workspace: implementationWorkspace,
    config: {
      implementation: implementationConfig
    },
    ...overrides
  });
}

describe("built-in steps", () => {
  it("runs preflight through injected dependencies", async () => {
    const runPreflight = vi.fn(async () => ({ status: "ok" }));

    await expect(
      runBuiltInStep({
        uses: "preflight",
        state: workflowState(),
        dependencies: { runPreflight }
      })
    ).resolves.toEqual({ status: "ok" });

    expect(runPreflight).toHaveBeenCalledWith({
      invocation,
      repository
    });
  });

  it("runs prepare_worktree through injected dependencies", async () => {
    const prepareWorktree = vi.fn(async () => workspace);

    await expect(
      runBuiltInStep({
        uses: "prepare_worktree",
        state: workflowState(),
        dependencies: { prepareWorktree }
      })
    ).resolves.toEqual(workspace);

    expect(prepareWorktree).toHaveBeenCalledWith({
      invocation,
      repository,
      workspaceRoot: "/tmp/worktrees",
      runId: "run-123"
    });
  });

  it("runs collect_repo_context with the workspace path overriding repository path", async () => {
    const collectRepoContext = vi.fn(async () => repoContext);

    await expect(
      runBuiltInStep({
        uses: "collect_repo_context",
        state: workflowState(),
        dependencies: { collectRepoContext }
      })
    ).resolves.toEqual(repoContext);

    expect(collectRepoContext).toHaveBeenCalledWith({
      invocation,
      repository: {
        ...repository,
        path: workspace.path
      }
    });
  });

  it("runs validate_code_review_findings through injected dependencies", async () => {
    const validatedFinding = { ...finding, confidence: "low" as const };
    const validateFindingEvidence = vi.fn(() => [validatedFinding]);

    await expect(
      runBuiltInStep({
        uses: "validate_code_review_findings",
        state: workflowState({
          steps: {
            repo_context: repoContext,
            code_review: { findings: [finding], summary: "Reviewed." }
          }
        }),
        input: {
          repo_context: "$.steps.repo_context",
          findings: "$.steps.code_review"
        },
        dependencies: { validateFindingEvidence }
      })
    ).resolves.toEqual({
      findings: [validatedFinding],
      summary: "Reviewed."
    });

    expect(validateFindingEvidence).toHaveBeenCalledWith(repoContext, [finding]);
  });

  it("runs final_code_review_report through injected dependencies", async () => {
    const buildFinalReportJson = vi.fn(() => ({ report_path: "/tmp/report.md" }));
    const buildFinalReportMarkdown = vi.fn(() => "# Report\n");

    await expect(
      runBuiltInStep({
        uses: "final_code_review_report",
        state: workflowState({
          steps: {
            validated_findings: { findings: [finding] },
            acceptance
          }
        }),
        input: {
          findings: "$.steps.validated_findings",
          acceptance: "$.steps.acceptance"
        },
        dependencies: { buildFinalReportJson, buildFinalReportMarkdown }
      })
    ).resolves.toEqual({
      json: { report_path: "/tmp/report.md" },
      markdown: "# Report\n"
    });

    expect(buildFinalReportJson).toHaveBeenCalledWith({
      acceptance,
      findings: [finding],
      reportPath: "/tmp/report.md",
      workspace
    });
    expect(buildFinalReportMarkdown).toHaveBeenCalledWith({
      invocation,
      findings: [finding],
      acceptance
    });
  });

  it("runs prepare_implementation_worktree through injected dependencies", async () => {
    const prepareImplementationWorktree = vi.fn(async () => implementationWorkspace);

    await expect(
      runBuiltInStep({
        uses: "prepare_implementation_worktree",
        state: implementationState(),
        dependencies: { prepareImplementationWorktree }
      })
    ).resolves.toEqual(implementationWorkspace);

    expect(prepareImplementationWorktree).toHaveBeenCalledWith({
      invocation: jiraInvocation,
      repository,
      workspaceRoot: "/tmp/worktrees",
      runId: "run-123",
      baseRef: "main",
      branchPattern: "feature/{slug}"
    });
  });

  it("collects minimum Jira task context without external calls", async () => {
    await expect(
      runBuiltInStep({
        uses: "collect_task_context",
        state: implementationState()
      })
    ).resolves.toEqual({
      jira: {
        issue_key: "ABC-123",
        summary: "Fix checkout validation",
        description: "Reject invalid checkout payloads.",
        acceptance_criteria: "Invalid payloads fail validation."
      },
      repository: {
        provider: "github",
        owner: "swinggo-dev",
        name: "swg-front-nuxt"
      }
    });
  });

  it("runs validation commands through injected dependencies", async () => {
    const runValidationCommands = vi.fn(async () => failedValidation);

    await expect(
      runBuiltInStep({
        uses: "run_validation_commands",
        state: implementationState(),
        dependencies: { runValidationCommands }
      })
    ).resolves.toEqual(failedValidation);

    expect(runValidationCommands).toHaveBeenCalledWith({
      cwd: implementationWorkspace.path,
      commands: [{ cmd: "npm", args: ["test"] }],
      maxOutputBytes: 1000
    });
  });

  it("collects worktree diff through injected dependencies", async () => {
    const collectWorktreeDiff = vi.fn(async () => worktreeDiff);

    await expect(
      runBuiltInStep({
        uses: "collect_worktree_diff",
        state: implementationState(),
        dependencies: { collectWorktreeDiff }
      })
    ).resolves.toEqual(worktreeDiff);

    expect(collectWorktreeDiff).toHaveBeenCalledWith({
      cwd: implementationWorkspace.path,
      maxDiffBytes: 1000
    });
  });

  it("runs commit_changes through injected dependencies and returns skipped gate artifacts", async () => {
    const commitChanges = vi.fn(async () => skippedCommitArtifact);

    await expect(
      runBuiltInStep({
        uses: "commit_changes",
        state: implementationState({
          config: {
            implementation: {
              ...implementationConfig,
              commit: {
                enabled: false
              }
            }
          },
          steps: {
            implementation: { final_validation: failedValidation },
            worktree_diff: worktreeDiff,
            acceptance: acceptedImplementation
          }
        }),
        dependencies: { commitChanges }
      })
    ).resolves.toEqual(skippedCommitArtifact);

    expect(commitChanges).toHaveBeenCalledWith({
      enabled: false,
      cwd: implementationWorkspace.path,
      validation: failedValidation,
      acceptance: acceptedImplementation,
      diff: worktreeDiff,
      branch: implementationWorkspace.branch,
      remote: "origin",
      baseSha: "abc123",
      branchPattern: "feature/{slug}",
      expectedRemoteUrls: repository.expected_remote_urls,
      message: "ABC-123: Fix checkout validation"
    });
  });

  it("runs push_branch through injected dependencies", async () => {
    const pushBranch = vi.fn(async () => pushArtifact);

    await expect(
      runBuiltInStep({
        uses: "push_branch",
        state: implementationState({
          steps: {
            commit: commitArtifact
          }
        }),
        dependencies: { pushBranch }
      })
    ).resolves.toEqual(pushArtifact);

    expect(pushBranch).toHaveBeenCalledWith({
      enabled: true,
      cwd: implementationWorkspace.path,
      commit: commitArtifact,
      branch: implementationWorkspace.branch,
      remote: "origin",
      expectedRemoteUrls: repository.expected_remote_urls
    });
  });

  it("runs open_pull_request through injected dependencies", async () => {
    const openPullRequest = vi.fn(async () => pullRequestArtifact);

    await expect(
      runBuiltInStep({
        uses: "open_pull_request",
        state: implementationState({
          steps: {
            push: pushArtifact
          }
        }),
        dependencies: { openPullRequest }
      })
    ).resolves.toEqual(pullRequestArtifact);

    expect(openPullRequest).toHaveBeenCalledWith({
      enabled: true,
      cwd: implementationWorkspace.path,
      push: pushArtifact,
      branch: implementationWorkspace.branch,
      provider: "github",
      baseRef: "main",
      draft: true,
      title: "ABC-123: Fix checkout validation",
      body: "Reject invalid checkout payloads."
    });
  });

  it("runs final_implementation_report through injected dependencies", async () => {
    const buildImplementationReportJson = vi.fn(() => ({
      report: "json"
    }));
    const buildImplementationReportMarkdown = vi.fn(() => "# Report\n");

    await expect(
      runBuiltInStep({
        uses: "final_implementation_report",
        state: implementationState({
          steps: {
            implementation: { final_validation: validation },
            commit: commitArtifact,
            push: pushArtifact,
            pull_request: pullRequestArtifact
          }
        }),
        dependencies: {
          buildImplementationReportJson,
          buildImplementationReportMarkdown
        }
      })
    ).resolves.toEqual({
      json: { report: "json" },
      markdown: "# Report\n"
    });

    const reportInput = {
      invocation: jiraInvocation,
      status: "ready_for_pr",
      branch: implementationWorkspace.branch,
      worktree: {
        path: implementationWorkspace.path,
        preserved: true,
        reason: "created"
      },
      validation,
      commit: commitArtifact,
      push: pushArtifact,
      pullRequest: pullRequestArtifact,
      trustedHostLocal: true
    };
    expect(buildImplementationReportJson).toHaveBeenCalledWith(reportInput);
    expect(buildImplementationReportMarkdown).toHaveBeenCalledWith(reportInput);
  });

  it.each([
    ["preflight", { repository: undefined }, "repository"],
    ["prepare_worktree", { run: undefined }, "run"],
    ["prepare_worktree", { workspaceRoot: undefined }, "workspaceRoot"],
    ["collect_repo_context", { workspace: undefined }, "workspace"]
  ] as const)(
    "throws a typed error when %s is missing required %s state",
    async (uses, stateOverrides, requiredState) => {
      await expect(
        runBuiltInStep({
          uses,
          state: workflowState(stateOverrides)
        })
      ).rejects.toMatchObject({
        code: "built_in_state_missing",
        message: expect.stringContaining(requiredState)
      });
    }
  );

  it("throws a typed error when validate_code_review_findings input is missing", async () => {
    await expect(
      runBuiltInStep({
        uses: "validate_code_review_findings",
        state: workflowState()
      })
    ).rejects.toMatchObject({
      code: "built_in_input_missing",
      message: expect.stringContaining("repo_context")
    });
  });

  it("throws a typed error when final_code_review_report report path state is missing", async () => {
    await expect(
      runBuiltInStep({
        uses: "final_code_review_report",
        state: workflowState({
          reportPath: undefined,
          steps: {
            validated_findings: { findings: [finding] },
            acceptance
          }
        }),
        input: {
          findings: "$.steps.validated_findings",
          acceptance: "$.steps.acceptance"
        }
      })
    ).rejects.toMatchObject({
      code: "built_in_state_missing",
      message: expect.stringContaining("reportPath")
    });
  });
});
