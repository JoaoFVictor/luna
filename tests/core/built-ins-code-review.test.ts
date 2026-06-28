import { describe, expect, it, vi } from "vitest";
import {
  collectRepoContextBuiltIn,
  finalCodeReviewReportBuiltIn,
  prepareWorktreeBuiltIn,
  validateCodeReviewFindingsBuiltIn
} from "../../src/providers/github/built-ins.js";
import { preflightBuiltIn } from "../../src/core/built-ins/preflight.js";
import type {
  WorkspaceRecord
} from "../../src/core/write-mode/types.js";
import type { RepoContext } from "../../src/core/git/diff/types.js";
import type { Invocation } from "../../src/core/router/invocation.js";
import type { RepositoryConfig } from "../../src/core/config/schemas.js";
import type { Finding } from "../../src/core/findings/types.js";
import type { AcceptanceDecision } from "../../src/core/decisions/types.js";
import type { ImplementationConfig } from "../../src/core/write-mode/types.js";
import type { WorkflowState } from "../../src/core/workflow/state.js";

const invocation: Invocation = {
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

function workflowState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    invocation,
    repository,
    run: { run_id: "run-123" },
    workspace,
    workspaceRoot: "/tmp/worktrees",
    steps: {},
    ...overrides
  };
}

describe("code review built-ins", () => {
  it("runs preflight through injected dependencies", async () => {
    const runPreflight = vi.fn(async () => ({ status: "ok" }));

    await expect(
      preflightBuiltIn.run({
        state: workflowState({
          workflow: { mode: "read_only" },
          config: { implementation: implementationConfig }
        }),
        dependencies: { runPreflight }
      })
    ).resolves.toEqual({ status: "ok" });

    expect(preflightBuiltIn.name).toBe("runtime.preflight");
    expect(runPreflight).toHaveBeenCalledWith({
      invocation,
      repository,
      workflow: { mode: "read_only" },
      implementation: implementationConfig
    });
  });

  it("runs prepare_worktree through injected dependencies and declares workspace metadata", async () => {
    const prepareWorktree = vi.fn(async () => workspace);

    await expect(
      prepareWorktreeBuiltIn.run({
        state: workflowState(),
        dependencies: { prepareWorktree }
      })
    ).resolves.toEqual(workspace);

    expect(prepareWorktreeBuiltIn.name).toBe("runtime.prepare_worktree");
    expect(prepareWorktreeBuiltIn.metadata).toEqual({
      capturesWorkspace: true,
      requiresRepository: true,
      locks: [{ resource: "repository", mode: "exclusive" }]
    });
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
      collectRepoContextBuiltIn.run({
        state: workflowState(),
        dependencies: { collectRepoContext }
      })
    ).resolves.toEqual(repoContext);

    expect(collectRepoContext).toHaveBeenCalledWith({
      repository: {
        ...repository,
        path: workspace.path
      },
      baseSha: invocation.references?.base_sha,
      headSha: invocation.references?.head_sha
    });
  });

  it("runs validate_code_review_findings and preserves the summary", async () => {
    const validatedFinding = { ...finding, confidence: "low" as const };
    const validateFindingEvidence = vi.fn(() => [validatedFinding]);

    await expect(
      validateCodeReviewFindingsBuiltIn.run({
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

  it("runs final_code_review_report through injected dependencies and declares deferral metadata", async () => {
    const buildFinalReportJson = vi.fn(() => ({ findings: [] }));
    const buildFinalReportMarkdown = vi.fn(() => "# Report\n");

    await expect(
      finalCodeReviewReportBuiltIn.run({
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
      json: { findings: [] },
      markdown: "# Report\n"
    });

    expect(finalCodeReviewReportBuiltIn.metadata).toEqual({
      deferredLifecycle: "final_report"
    });
    expect(buildFinalReportJson).toHaveBeenCalledWith({
      acceptance,
      findings: [finding],
      workspace
    });
    expect(buildFinalReportMarkdown).toHaveBeenCalledWith({
      invocation,
      findings: [finding],
      acceptance
    });
  });

  it.each([
    prepareWorktreeBuiltIn,
    collectRepoContextBuiltIn,
    finalCodeReviewReportBuiltIn
  ])("rejects Jira invocations for %s", async (builtIn) => {
    await expect(
      builtIn.run({
        state: workflowState({
          invocation: jiraInvocation,
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
      code: "built_in_unsupported",
      message: "Built-in step requires GitHub pull request invocation"
    });
  });

  it("throws a typed error when validate_code_review_findings is missing findings", async () => {
    await expect(
      validateCodeReviewFindingsBuiltIn.run({
        state: workflowState(),
        input: {
          repo_context: repoContext,
          findings: { summary: "Reviewed." }
        }
      })
    ).rejects.toMatchObject({
      code: "built_in_input_missing",
      message: "Built-in step requires input.findings.findings"
    });
  });

  it("throws a typed error when validate_code_review_findings is missing repo_context", async () => {
    await expect(
      validateCodeReviewFindingsBuiltIn.run({
        state: workflowState(),
        input: {
          findings: { findings: [finding], summary: "Reviewed." }
        }
      })
    ).rejects.toMatchObject({
      code: "built_in_input_missing",
      message: "Built-in step requires input.repo_context"
    });
  });

  it("throws a typed error when validate_code_review_findings receives malformed findings", async () => {
    await expect(
      validateCodeReviewFindingsBuiltIn.run({
        state: workflowState(),
        input: {
          repo_context: repoContext,
          findings: { findings: "not-an-array", summary: "Reviewed." }
        }
      })
    ).rejects.toMatchObject({
      code: "built_in_input_missing",
      message: "Built-in step requires input.findings.findings"
    });
  });

  it.each([
    ["preflight", preflightBuiltIn, { repository: undefined }, "repository"],
    ["prepare_worktree", prepareWorktreeBuiltIn, { run: undefined }, "run"],
    [
      "prepare_worktree",
      prepareWorktreeBuiltIn,
      { workspaceRoot: undefined },
      "workspaceRoot"
    ],
    [
      "collect_repo_context",
      collectRepoContextBuiltIn,
      { workspace: undefined },
      "workspace"
    ]
  ] as const)(
    "throws a typed error when %s is missing required %s state",
    async (_name, builtIn, stateOverrides, requiredState) => {
      await expect(
        builtIn.run({
          state: workflowState(stateOverrides)
        })
      ).rejects.toMatchObject({
        code: "built_in_state_missing",
        message: expect.stringContaining(requiredState)
      });
    }
  );

});
