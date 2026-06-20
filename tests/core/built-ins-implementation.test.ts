import { describe, expect, it, vi } from "vitest";
import {
  collectTaskContextBuiltIn,
  collectWorktreeDiffBuiltIn,
  commitChangesBuiltIn,
  finalImplementationReportBuiltIn,
  openPullRequestBuiltIn,
  prepareImplementationWorktreeBuiltIn,
  pushBranchBuiltIn,
  runValidationCommandsBuiltIn
} from "../../src/core/built-ins/implementation.js";
import type {
  CommitChangesArtifact,
  ImplementationConfig,
  Invocation,
  PullRequestArtifact,
  PushBranchArtifact,
  RepositoryConfig,
  ValidationResult,
  WorkspaceRecord
} from "../../src/core/types.js";
import type { ImplementationWorktreeRecord } from "../../src/core/implementation-worktree-manager.js";
import type { WorktreeDiff } from "../../src/core/worktree-diff-collector.js";
import type { BuiltInStepRunOptions } from "../../src/core/built-ins/types.js";
import type { WorkflowState } from "../../src/core/workflow-state.js";

const githubInvocation: Invocation = {
  version: "2026-06",
  source: "github",
  event: "pull_request",
  action: "selected",
  repository: { provider: "github", owner: "octo-org", name: "hello-world" },
  subject: {
    type: "pull_request",
    id: "42",
    url: "https://github.com/octo-org/hello-world/pull/42"
  },
  references: {
    base_ref: "main",
    base_sha: "abc123",
    head_sha: "def456"
  },
  payload: {
    pull_request: { number: 42 },
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
    }
  }
};

const jiraInvocation: Invocation = {
  version: "2026-06",
  source: "jira",
  event: "issue",
  action: "selected",
  repository: {
    provider: "github",
    owner: "swinggo-dev",
    name: "swg-front-nuxt"
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
  repository_id: "repo",
  remote: "origin",
  base_ref: "main",
  base_sha: "abc123",
  branch: "feature/abc-123-fix-checkout-validation"
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

function implementationState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    invocation: jiraInvocation,
    repository,
    run: { run_id: "run-123" },
    workspace: implementationWorkspace,
    workspaceRoot: "/tmp/worktrees",
    reportPath: "/tmp/report.md",
    steps: {},
    config: {
      implementation: implementationConfig
    },
    ...overrides
  };
}

async function runBuiltIn(
  builtIn: {
    run(options: BuiltInStepRunOptions): unknown;
  },
  options: BuiltInStepRunOptions
): Promise<unknown> {
  return await Promise.resolve().then(() => builtIn.run(options));
}

describe("implementation built-ins", () => {
  it("runs prepare_implementation_worktree through injected dependencies", async () => {
    const prepareImplementationWorktree = vi.fn(async () => implementationWorkspace);

    await expect(
      prepareImplementationWorktreeBuiltIn.run({
        state: implementationState(),
        dependencies: { prepareImplementationWorktree }
      })
    ).resolves.toEqual(implementationWorkspace);

    expect(prepareImplementationWorktreeBuiltIn.metadata).toEqual({
      capturesWorkspace: true
    });
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
      runBuiltIn(collectTaskContextBuiltIn, { state: implementationState() })
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
      runValidationCommandsBuiltIn.run({
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
      collectWorktreeDiffBuiltIn.run({
        state: implementationState(),
        dependencies: { collectWorktreeDiff }
      })
    ).resolves.toEqual(worktreeDiff);

    expect(collectWorktreeDiff).toHaveBeenCalledWith({
      cwd: implementationWorkspace.path,
      maxDiffBytes: 1000
    });
  });

  it("runs commit_changes through injected dependencies", async () => {
    const commitChanges = vi.fn(async () => skippedCommitArtifact);

    await expect(
      commitChangesBuiltIn.run({
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
      pushBranchBuiltIn.run({
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
      openPullRequestBuiltIn.run({
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

  it("runs final_implementation_report as ready_for_pr through injected dependencies", async () => {
    const buildImplementationReportJson = vi.fn(() => ({
      report: "json"
    }));
    const buildImplementationReportMarkdown = vi.fn(() => "# Report\n");

    await expect(
      runBuiltIn(finalImplementationReportBuiltIn, {
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
    expect(finalImplementationReportBuiltIn.metadata).toEqual({
      deferUntilAfterWorkspaceLifecycle: true
    });
    expect(buildImplementationReportJson).toHaveBeenCalledWith(reportInput);
    expect(buildImplementationReportMarkdown).toHaveBeenCalledWith(reportInput);
  });

  it("runs final_implementation_report as validation_failed when validation fails", async () => {
    const buildImplementationReportJson = vi.fn(() => ({
      report: "json"
    }));
    const buildImplementationReportMarkdown = vi.fn(() => "# Report\n");

    await finalImplementationReportBuiltIn.run({
      state: implementationState({
        steps: {
          implementation: { final_validation: failedValidation },
          commit: commitArtifact,
          push: pushArtifact,
          pull_request: pullRequestArtifact
        }
      }),
      dependencies: {
        buildImplementationReportJson,
        buildImplementationReportMarkdown
      }
    });

    expect(buildImplementationReportJson).toHaveBeenCalledWith(
      expect.objectContaining({ status: "validation_failed" })
    );
  });

  it("runs final_implementation_report as completed_with_skips when publish steps are skipped", async () => {
    const buildImplementationReportJson = vi.fn(() => ({
      report: "json"
    }));
    const buildImplementationReportMarkdown = vi.fn(() => "# Report\n");

    await finalImplementationReportBuiltIn.run({
      state: implementationState({
        steps: {
          implementation: { final_validation: validation },
          commit: skippedCommitArtifact,
          push: pushArtifact,
          pull_request: pullRequestArtifact
        }
      }),
      dependencies: {
        buildImplementationReportJson,
        buildImplementationReportMarkdown
      }
    });

    expect(buildImplementationReportJson).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed_with_skips" })
    );
  });

  it.each([
    prepareImplementationWorktreeBuiltIn,
    collectTaskContextBuiltIn,
    commitChangesBuiltIn,
    openPullRequestBuiltIn,
    finalImplementationReportBuiltIn
  ])("rejects GitHub invocation for Jira-only built-in $name", async (builtIn) => {
    await expect(
      runBuiltIn(builtIn, {
        state: implementationState({
          invocation: githubInvocation,
          steps: {
            implementation: { final_validation: validation },
            acceptance: acceptedImplementation,
            worktree_diff: worktreeDiff,
            commit: commitArtifact,
            push: pushArtifact,
            pull_request: pullRequestArtifact
          }
        })
      })
    ).rejects.toMatchObject({ code: "built_in_unsupported" });
  });

  it.each([
    prepareImplementationWorktreeBuiltIn,
    runValidationCommandsBuiltIn,
    collectWorktreeDiffBuiltIn,
    commitChangesBuiltIn,
    pushBranchBuiltIn,
    openPullRequestBuiltIn,
    finalImplementationReportBuiltIn
  ])("rejects missing implementation config for $name", async (builtIn) => {
    await expect(
      runBuiltIn(builtIn, {
        state: implementationState({
          config: undefined,
          steps: {
            implementation: { final_validation: validation },
            acceptance: acceptedImplementation,
            worktree_diff: worktreeDiff,
            commit: commitArtifact,
            push: pushArtifact,
            pull_request: pullRequestArtifact
          }
        })
      })
    ).rejects.toMatchObject({
      code: "built_in_state_missing",
      message: expect.stringContaining("config.implementation")
    });
  });

  it.each([
    ["branch", commitChangesBuiltIn, "workspace.branch"],
    ["remote", pushBranchBuiltIn, "workspace.remote"],
    ["base_sha", finalImplementationReportBuiltIn, "workspace.base_sha"]
  ] as const)("rejects missing workspace.%s", async (field, builtIn, expectedMessage) => {
    const brokenWorkspace = { ...implementationWorkspace };
    delete brokenWorkspace[field];

    await expect(
      runBuiltIn(builtIn, {
        state: implementationState({
          workspace: brokenWorkspace,
          steps: {
            implementation: { final_validation: validation },
            acceptance: acceptedImplementation,
            worktree_diff: worktreeDiff,
            commit: commitArtifact,
            push: pushArtifact,
            pull_request: pullRequestArtifact
          }
        })
      })
    ).rejects.toMatchObject({
      code: "built_in_state_missing",
      message: expect.stringContaining(expectedMessage)
    });
  });

  it.each([
    ["acceptance", commitChangesBuiltIn, "steps.acceptance"],
    ["diff", commitChangesBuiltIn, "steps.worktree_diff"],
    ["commit", pushBranchBuiltIn, "steps.commit"],
    ["push", openPullRequestBuiltIn, "steps.push"],
    ["pull_request", finalImplementationReportBuiltIn, "steps.pull_request"]
  ] as const)(
    "rejects missing %s when input and state.steps fallback are absent",
    async (_missing, builtIn, expectedMessage) => {
      const steps =
        _missing === "pull_request"
          ? {
              implementation: { final_validation: validation },
              commit: commitArtifact,
              push: pushArtifact
            }
          : _missing === "diff"
            ? {
                implementation: { final_validation: validation },
                acceptance: acceptedImplementation
              }
          : {
              implementation: { final_validation: validation }
            };

      await expect(
        runBuiltIn(builtIn, {
          state: implementationState({
            steps
          })
        })
      ).rejects.toMatchObject({
        code: "built_in_state_missing",
        message: expect.stringContaining(expectedMessage)
      });
    }
  );

  it("uses state.steps fallbacks for commit_changes inputs", async () => {
    const commitChanges = vi.fn(async () => commitArtifact);

    await commitChangesBuiltIn.run({
      state: implementationState({
        steps: {
          implementation: { final_validation: validation },
          acceptance: acceptedImplementation,
          worktree_diff: worktreeDiff
        }
      }),
      dependencies: { commitChanges }
    });

    expect(commitChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        validation,
        acceptance: acceptedImplementation,
        diff: worktreeDiff
      })
    );
  });

  it("uses state.steps fallbacks for push_branch, open_pull_request, and final report", async () => {
    const pushBranch = vi.fn(async () => pushArtifact);
    const openPullRequest = vi.fn(async () => pullRequestArtifact);
    const buildImplementationReportJson = vi.fn(() => ({ report: "json" }));

    await pushBranchBuiltIn.run({
      state: implementationState({ steps: { commit: commitArtifact } }),
      dependencies: { pushBranch }
    });
    await openPullRequestBuiltIn.run({
      state: implementationState({ steps: { push: pushArtifact } }),
      dependencies: { openPullRequest }
    });
    await finalImplementationReportBuiltIn.run({
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
        buildImplementationReportMarkdown: vi.fn(() => "# Report\n")
      }
    });

    expect(pushBranch).toHaveBeenCalledWith(expect.objectContaining({ commit: commitArtifact }));
    expect(openPullRequest).toHaveBeenCalledWith(expect.objectContaining({ push: pushArtifact }));
    expect(buildImplementationReportJson).toHaveBeenCalledWith(
      expect.objectContaining({
        validation,
        commit: commitArtifact,
        push: pushArtifact,
        pullRequest: pullRequestArtifact
      })
    );
  });
});
