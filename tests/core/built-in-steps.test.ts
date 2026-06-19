import { describe, expect, it, vi } from "vitest";
import { runBuiltInStep } from "../../src/core/built-in-steps.js";
import type {
  AcceptanceDecision,
  Finding,
  Invocation,
  RepoContext,
  RepositoryConfig,
  WorkspaceRecord
} from "../../src/core/types.js";
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
  remote: "origin"
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
  decision: "request_changes",
  summary: "One issue remains.",
  blocking_findings: ["Issue"]
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
