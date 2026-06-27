import { describe, expect, it, vi } from "vitest";
import {
  collectWorktreeDiffBuiltIn,
  prepareCommitBuiltIn,
  prepareImplementationWorktreeBuiltIn,
  preparePushBuiltIn,
  recordAcceptanceDecisionBuiltIn,
  recordCommitLifecycleBuiltIn,
  recordImplementationValidationBuiltIn,
  recordPushLifecycleBuiltIn,
  runValidationCommandsBuiltIn
} from "../../src/core/built-ins/implementation.js";
import {
  collectTaskContext as collectJiraTaskContext,
  finalImplementationReport as finalJiraImplementationReport
} from "../../src/providers/jira/built-ins.js";
import type { Invocation } from "../../src/core/router/invocation.js";
import type { WorkspaceRecord } from "../../src/core/write-mode/types.js";
import type { RepositoryConfig } from "../../src/core/config/schemas.js";
import type { AcceptanceDecision } from "../../src/core/decisions/types.js";
import type { ValidationResult } from "../../src/core/validation/runner.js";
import type {
  CommitChangesArtifact,
  ImplementationConfig,
  PushBranchArtifact
} from "../../src/core/write-mode/types.js";
import type { ChangeRequestArtifact } from "../../src/core/change-request/contracts.js";
import type { ImplementationWorktreeRecord } from "../../src/core/write-mode/worktree.js";
import type { WorktreeDiff } from "../../src/core/git/diff/worktree-diff.js";
import type { BuiltInStepRunOptions } from "../../src/core/built-ins/types.js";
import type { WorkflowState } from "../../src/core/workflow/state.js";
import type { ImplementationReportInput } from "../../src/core/reports/implementation-report.js";
import { implementationReportRenderersFrom } from "../../src/core/built-ins/implementation-report.js";

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

const acceptedImplementation: AcceptanceDecision = {
  status: "accepted",
  summary: "Accepted",
  blocking_reasons: [],
  recommended_action: "approve"
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

const changeRequestArtifact: ChangeRequestArtifact = {
  operation_id: "change-request.create",
  enabled: true,
  skipped: false,
  provider: "github",
  provider_id: "github",
  external_id: "42",
  url: "https://github.com/octo-org/hello-world/pull/42",
  title: "Reject invalid checkout payloads.",
  source_branch: implementationWorkspace.branch,
  target_branch: "main",
  adopted: false
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
  it("resolves implementation report renderers from optional dependencies with typed fallbacks", () => {
    const defaultBuildJson = vi.fn(() => ({ report: "default-json" }));
    const defaultBuildMarkdown = vi.fn(() => "# Default\n");
    const buildImplementationReportJson = vi.fn(() => ({ report: "custom-json" }));
    const buildImplementationReportMarkdown = vi.fn(() => "# Custom\n");
    const reportInput: ImplementationReportInput = {
      invocation: jiraInvocation,
      status: "ready_for_change_request",
      branch: implementationWorkspace.branch,
      worktree: {
        path: implementationWorkspace.path,
        preserved: implementationWorkspace.preserved,
        reason: implementationWorkspace.reason
      },
      validation,
      commit: commitArtifact,
      push: pushArtifact,
      changeRequest: changeRequestArtifact,
      trustedHostLocal: true
    };

    const custom = implementationReportRenderersFrom({
      dependencies: {
        buildImplementationReportJson,
        buildImplementationReportMarkdown
      },
      defaultBuildJson,
      defaultBuildMarkdown
    });

    expect(custom.buildJson(reportInput)).toEqual({ report: "custom-json" });
    expect(custom.buildMarkdown(reportInput)).toBe("# Custom\n");

    const fallback = implementationReportRenderersFrom({
      dependencies: {
        buildImplementationReportJson: "not-a-function",
        buildImplementationReportMarkdown: false
      },
      defaultBuildJson,
      defaultBuildMarkdown
    });

    expect(fallback.buildJson(reportInput)).toEqual({ report: "default-json" });
    expect(fallback.buildMarkdown(reportInput)).toBe("# Default\n");
  });

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

    expect(prepareImplementationWorktreeBuiltIn.metadata).toEqual({
      implementationLifecycle: "workspace",
      capturesWorkspace: true,
      requiresRepository: true,
      locks: [{ resource: "repository", mode: "exclusive" }]
    });
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

  it("collects minimum Jira task context without external calls", async () => {
    await expect(
      runBuiltIn(collectJiraTaskContext, { state: implementationState() })
    ).resolves.toEqual({
      implementation_title: "ABC-123: Fix checkout validation",
      implementation_subject: {
        key: "ABC-123",
        title: "Fix checkout validation"
      },
      change_request_body: "Reject invalid checkout payloads.",
      jira: {
        issue_key: "ABC-123",
        summary: "Fix checkout validation",
        description: "Reject invalid checkout payloads.",
        acceptance_criteria: "Invalid payloads fail validation."
      },
      repository: {
        provider: "github",
        owner: "octo-org",
        name: "hello-world"
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

  it("records validation and acceptance from a gated implementation loop", async () => {
    await expect(
      runBuiltIn(recordImplementationValidationBuiltIn, {
        state: implementationState(),
        input: {
          implementation: {
            status: "passed",
            attempts_exhausted: false,
            attempts: [],
            validation,
            final_validation: validation,
            gates: [
              { id: "validation", type: "validation_commands", passed: true },
              { id: "acceptance", type: "agent", passed: true }
            ],
            result: {
              status: "passed",
              acceptance: acceptedImplementation
            }
          }
        }
      })
    ).resolves.toEqual({
      validation,
      acceptance: acceptedImplementation
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
                },
                diff_summary: {
                  files: [],
                  untracked_files: [],
                  untracked_summaries: [],
                  staged_diff: "",
                  unstaged_diff: "",
                  staged_diff_truncated: false,
                  unstaged_diff_truncated: false,
                  max_diff_bytes: 1000
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

  it("prepares git.commit input after deterministic implementation gates pass", async () => {
    expect(
      prepareCommitBuiltIn.run({
        state: implementationState({
          steps: {
            implementation: { final_validation: validation },
            worktree_diff: worktreeDiff,
            acceptance: acceptedImplementation
          }
        }),
        input: {
          message: "ABC-123: Fix checkout validation"
        }
      })
    ).toEqual({
      operation_id: "git.commit",
      message: "ABC-123: Fix checkout validation",
      paths: ["src/checkout.ts"],
      expected_branch: implementationWorkspace.branch,
      expected_base_sha: implementationWorkspace.base_sha,
      remote: "origin",
      expected_remote_urls: repository.expected_remote_urls
    });
  });

  it("prepares git.commit skip input when commit is disabled", async () => {
    expect(
      prepareCommitBuiltIn.run({
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
        input: {
          message: "ABC-123: Fix checkout validation"
        }
      })
    ).toEqual(skippedCommitArtifact);
  });

  it("records git.commit output as implementation commit lifecycle", () => {
    expect(
      recordCommitLifecycleBuiltIn.run({
        state: implementationState(),
        input: {
          commit: {
            operation_id: "git.commit",
            workspace_id: "workspace-1",
            branch: implementationWorkspace.branch,
            head_sha: "abc123",
            commit_sha: commitArtifact.commit_sha,
            message: "ABC-123: Fix checkout validation",
            adopted: false
          }
        }
      })
    ).toEqual(commitArtifact);
  });

  it("prepares git.push_branch input from recorded commit lifecycle", () => {
    expect(
      preparePushBuiltIn.run({
        state: implementationState({
          steps: {
            commit_lifecycle: commitArtifact
          }
        }),
        input: {
          commit: commitArtifact
        }
      })
    ).toEqual({
      operation_id: "git.push_branch",
      branch: implementationWorkspace.branch,
      remote: "origin",
      expected_commit_sha: commitArtifact.commit_sha,
      expected_remote_urls: repository.expected_remote_urls
    });
  });

  it("records git.push_branch output as implementation push lifecycle", () => {
    expect(
      recordPushLifecycleBuiltIn.run({
        state: implementationState(),
        input: {
          push: {
            operation_id: "git.push_branch",
            workspace_id: "workspace-1",
            branch: implementationWorkspace.branch,
            remote: "origin",
            commit_sha: "def456",
            pushed: true
          }
        }
      })
    ).toEqual(pushArtifact);
  });

  it("runs final_implementation_report as ready_for_change_request through injected dependencies", async () => {
    const buildImplementationReportJson = vi.fn(() => ({
      report: "json"
    }));
    const buildImplementationReportMarkdown = vi.fn(() => "# Report\n");

    await expect(
      runBuiltIn(finalJiraImplementationReport, {
        state: implementationState({
          steps: {
            implementation: { final_validation: validation },
            commit_lifecycle: commitArtifact,
            push_lifecycle: pushArtifact,
            change_request: changeRequestArtifact
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
      status: "ready_for_change_request",
      branch: implementationWorkspace.branch,
      worktree: {
        path: implementationWorkspace.path,
        preserved: true,
        reason: "created"
      },
      validation,
      commit: commitArtifact,
      push: pushArtifact,
      changeRequest: changeRequestArtifact,
      trustedHostLocal: true
    };
    expect(buildImplementationReportJson).toHaveBeenCalledWith(reportInput);
    expect(buildImplementationReportMarkdown).toHaveBeenCalledWith(reportInput);
  });

  it("runs final_implementation_report as validation_failed when validation fails", async () => {
    const buildImplementationReportJson = vi.fn(() => ({
      report: "json"
    }));
    const buildImplementationReportMarkdown = vi.fn(() => "# Report\n");

    await runBuiltIn(finalJiraImplementationReport, {
      state: implementationState({
        steps: {
          implementation: { final_validation: failedValidation },
          commit_lifecycle: commitArtifact,
          push_lifecycle: pushArtifact,
          change_request: changeRequestArtifact
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

    await runBuiltIn(finalJiraImplementationReport, {
      state: implementationState({
        steps: {
          implementation: { final_validation: validation },
          commit_lifecycle: skippedCommitArtifact,
          push_lifecycle: pushArtifact,
          change_request: changeRequestArtifact
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
    collectJiraTaskContext,
    finalJiraImplementationReport
  ])("rejects GitHub invocation for Jira-only built-in $name", async (builtIn) => {
    await expect(
      runBuiltIn(builtIn, {
        state: implementationState({
          invocation: githubInvocation,
          steps: {
            implementation: { final_validation: validation },
            acceptance: acceptedImplementation,
            worktree_diff: worktreeDiff,
            commit_lifecycle: commitArtifact,
            push_lifecycle: pushArtifact,
            change_request: changeRequestArtifact
          }
        })
      })
    ).rejects.toMatchObject({ code: "built_in_unsupported" });
  });

  it.each([
    prepareImplementationWorktreeBuiltIn,
    runValidationCommandsBuiltIn,
    collectWorktreeDiffBuiltIn,
    prepareCommitBuiltIn,
    preparePushBuiltIn,
    finalJiraImplementationReport
  ])("rejects missing implementation config for $name", async (builtIn) => {
    await expect(
      runBuiltIn(builtIn, {
        state: implementationState({
          config: undefined,
          steps: {
            implementation: { final_validation: validation },
            acceptance: acceptedImplementation,
            worktree_diff: worktreeDiff,
            commit_lifecycle: commitArtifact,
            push_lifecycle: pushArtifact,
            change_request: changeRequestArtifact
          }
        })
      })
    ).rejects.toMatchObject({
      code: "built_in_state_missing",
      message: expect.stringContaining("config.implementation")
    });
  });

  it.each([
    ["branch", prepareCommitBuiltIn, "workspace.branch"],
    ["remote", preparePushBuiltIn, "workspace.remote"],
    ["base_sha", finalJiraImplementationReport, "workspace.base_sha"]
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
            commit_lifecycle: commitArtifact,
            push_lifecycle: pushArtifact,
            change_request: changeRequestArtifact
          }
        })
      })
    ).rejects.toMatchObject({
      code: "built_in_state_missing",
      message: expect.stringContaining(expectedMessage)
    });
  });

  it.each([
    ["acceptance", prepareCommitBuiltIn, "steps.acceptance"],
    ["diff", prepareCommitBuiltIn, "steps.worktree_diff"],
    ["commit", preparePushBuiltIn, "steps.commit_lifecycle"],
    ["change_request", finalJiraImplementationReport, "steps.change_request"]
  ] as const)(
    "rejects missing %s when input and state.steps fallback are absent",
    async (_missing, builtIn, expectedMessage) => {
      const steps =
        _missing === "change_request"
          ? {
              implementation: { final_validation: validation },
              commit_lifecycle: commitArtifact,
              push_lifecycle: pushArtifact
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

  it("uses state.steps fallbacks for prepare_commit inputs", async () => {
    expect(prepareCommitBuiltIn.run({
      state: implementationState({
        steps: {
          implementation: { final_validation: validation },
          acceptance: acceptedImplementation,
          worktree_diff: worktreeDiff
        }
      }),
      input: {
        message: "ABC-123: Fix checkout validation"
      }
    })).toMatchObject({ operation_id: "git.commit" });
  });

  it("uses state.steps fallbacks for prepare_push and final report", async () => {
    const buildImplementationReportJson = vi.fn(() => ({ report: "json" }));

    expect(
      preparePushBuiltIn.run({
        state: implementationState({ steps: { commit_lifecycle: commitArtifact } })
      })
    ).toMatchObject({ operation_id: "git.push_branch" });
    await runBuiltIn(finalJiraImplementationReport, {
      state: implementationState({
        steps: {
          implementation: { final_validation: validation },
          commit_lifecycle: commitArtifact,
          push_lifecycle: pushArtifact,
          change_request: changeRequestArtifact
        }
      }),
      dependencies: {
        buildImplementationReportJson,
        buildImplementationReportMarkdown: vi.fn(() => "# Report\n")
      }
    });

    expect(buildImplementationReportJson).toHaveBeenCalledWith(
      expect.objectContaining({
        validation,
        commit: commitArtifact,
        push: pushArtifact,
        changeRequest: changeRequestArtifact
      })
    );
  });
});
