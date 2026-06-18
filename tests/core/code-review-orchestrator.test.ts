import { mkdtemp, readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeCodeReview } from "../../src/core/code-review-orchestrator.js";
import type { PreflightResult } from "../../src/core/preflight.js";
import type {
  AcceptanceDecision,
  AppConfig,
  CodeReviewFindings,
  Invocation,
  RepoContext,
  RepositoriesConfig,
  ReviewPlan,
  RouteTarget,
  RoutingConfig,
  WorkspaceRecord
} from "../../src/core/types.js";
import { gitInvocation, gitRepository } from "../fixtures/git-repo.js";

type HarnessOptions = {
  artifactRoot?: string;
  workspaceRoot?: string;
  preserveOnFailure?: boolean;
  preserveOnSuccess?: boolean;
  route?: () => RouteTarget;
  resolveRepository?: () => typeof gitRepository;
  runPreflight?: () => Promise<PreflightResult>;
  prepareWorktree?: () => Promise<WorkspaceRecord>;
  collectRepoContext?: () => Promise<RepoContext>;
  cleanupWorktree?: (
    options: Record<string, unknown>
  ) => Promise<WorkspaceRecord>;
  plannerOutput?: unknown;
  reviewerOutput?: unknown;
  acceptanceOutput?: unknown;
};

const runId = "20260618t120000z-octo-hello-pr-42-a1";
const workspaceRecord: WorkspaceRecord = {
  run_id: runId,
  path: "/tmp/luna-workspaces/octo-hello/run",
  preserved: true,
  reason: "created"
};
const reviewPlan: ReviewPlan = {
  summary: "Review authentication changes.",
  focus_areas: ["auth"],
  files_to_review: ["src/auth.ts"]
};
const findings: CodeReviewFindings = {
  findings: [
    {
      title: "Unsafe update",
      severity: "high",
      confidence: "high",
      description: "Request body is trusted directly.",
      evidence: [
        {
          path: "src/auth.ts",
          line_start: 2,
          line_end: 2,
          quote: "updateUser(request.body)"
        }
      ],
      recommendation: "Validate the request body."
    }
  ],
  summary: "One issue found."
};
const acceptance: AcceptanceDecision = {
  decision: "request_changes",
  summary: "One blocking issue remains.",
  blocking_findings: ["Unsafe update"]
};
const repoContext: RepoContext = {
  repository: {
    owner: gitRepository.owner,
    name: gitRepository.name,
    full_name: `${gitRepository.owner}/${gitRepository.name}`
  },
  base_sha: gitInvocation.references.base_sha,
  head_sha: gitInvocation.references.head_sha,
  files: [
    {
      path: "src/auth.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1,3 +1,3 @@\n updateUser(request.body)\n",
      excerpt: {
        start_line: 1,
        end_line: 3,
        content: "before\nupdateUser(request.body)\nafter\n"
      }
    }
  ]
};
const routing: RoutingConfig = {
  routes: [
    {
      name: "github-pr",
      when: { source: "github", event_in: ["pull_request.opened"] },
      target: { type: "workflow", id: "code-review" }
    }
  ]
};
const repositories: RepositoriesConfig = {
  repositories: [gitRepository]
};

async function tempRoot(name: string): Promise<string> {
  return await realpath(await mkdtemp(path.join(tmpdir(), name)));
}

function codedError(code: string, message = code): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

async function readJson(root: string, name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(root, runId, name), "utf8"));
}

async function runArtifacts(root: string): Promise<string[]> {
  return (await readdir(path.join(root, runId))).sort();
}

async function createHarness(options: HarnessOptions = {}) {
  const artifactRoot = options.artifactRoot ?? (await tempRoot("luna-orch-artifacts-"));
  const workspaceRoot = options.workspaceRoot ?? (await tempRoot("luna-orch-workspaces-"));
  const cleanupWorktree = vi.fn(
    options.cleanupWorktree ??
      (async ({ workspaceRecord: record }) => ({
        ...(record as WorkspaceRecord),
        preserved: false,
        reason: "success_cleanup"
      }))
  );
  const route = vi.fn(
    options.route ?? (() => ({ type: "workflow", id: "code-review" }) satisfies RouteTarget)
  );
  const runPreflight = vi.fn(
    options.runPreflight ??
      (async () => ({
        repository: {
          id: gitRepository.id,
          path: gitRepository.path,
          remote: gitRepository.remote,
          remote_url: "git@github.com:octo-org/hello-world.git"
        },
        expected: {
          base_ref: gitInvocation.base_ref,
          base_sha: gitInvocation.references.base_sha,
          head_sha: gitInvocation.references.head_sha
        }
      }))
  );
  const prepareWorktree = vi.fn(
    options.prepareWorktree ?? (async () => workspaceRecord)
  );
  const collectRepoContext = vi.fn(
    options.collectRepoContext ?? (async () => repoContext)
  );

  return {
    artifactRoot,
    workspaceRoot,
    cleanupWorktree,
    route,
    runPreflight,
    prepareWorktree,
    collectRepoContext,
    options: {
      invocation: gitInvocation,
      configs: {
        app: {
          workspace: {
            strategy: "git_worktree",
            root: workspaceRoot,
            preserve_on_success: options.preserveOnSuccess ?? false,
            preserve_on_failure: options.preserveOnFailure ?? false
          },
          artifacts: { root: artifactRoot }
        } satisfies AppConfig,
        repositories,
        routing
      },
      nodes: {
        reviewPlanner: {
          execute: async () => options.plannerOutput ?? reviewPlan
        },
        codeReviewer: {
          execute: async () => options.reviewerOutput ?? findings
        },
        acceptanceReviewer: {
          execute: async () => options.acceptanceOutput ?? acceptance
        }
      },
      dependencies: {
        createRunIdentity: () => ({
          run_id: runId,
          target: "github_pr" as const,
          started_at: "2026-06-18T12:00:00.000Z"
        }),
        routeInvocation: route,
        resolveRepository: vi.fn(options.resolveRepository ?? (() => gitRepository)),
        runPreflight,
        prepareWorktree,
        cleanupWorktree,
        collectRepoContext
      }
    }
  };
}

describe("code review orchestrator", () => {
  it("writes every success artifact and final reports", async () => {
    const harness = await createHarness();

    await executeCodeReview(harness.options);

    await expect(runArtifacts(harness.artifactRoot)).resolves.toEqual([
      "acceptance-review.json",
      "code-review-findings.json",
      "final-report.json",
      "final-report.md",
      "invocation.json",
      "preflight.json",
      "repo-context.json",
      "review-plan.json",
      "run.json",
      "workspace.json"
    ]);
  });

  it("writes invocation, run, and error after no_route_matched", async () => {
    const harness = await createHarness({
      route: () => {
        throw codedError("no_route_matched", "No route matched invocation");
      }
    });

    await expect(executeCodeReview(harness.options)).rejects.toMatchObject({
      code: "no_route_matched"
    });

    await expect(runArtifacts(harness.artifactRoot)).resolves.toEqual([
      "error.json",
      "invocation.json",
      "run.json"
    ]);
    await expect(readJson(harness.artifactRoot, "error.json")).resolves.toMatchObject({
      code: "no_route_matched",
      message: "No route matched invocation"
    });
  });

  it("writes invocation, run, and error after repository_not_configured", async () => {
    const harness = await createHarness({
      resolveRepository: () => {
        throw codedError("repository_not_configured");
      }
    });

    await expect(executeCodeReview(harness.options)).rejects.toMatchObject({
      code: "repository_not_configured"
    });

    await expect(runArtifacts(harness.artifactRoot)).resolves.toEqual([
      "error.json",
      "invocation.json",
      "run.json"
    ]);
  });

  it.each([
    "repository_path_missing",
    "not_git_repository"
  ])("writes error.json for %s", async (code) => {
    const harness = await createHarness({
      runPreflight: async () => {
        throw codedError(code);
      }
    });

    await expect(executeCodeReview(harness.options)).rejects.toMatchObject({
      code
    });

    await expect(readJson(harness.artifactRoot, "error.json")).resolves.toMatchObject({
      code
    });
  });

  it("writes preflight when git_fetch_failed occurs after preflight", async () => {
    const harness = await createHarness({
      prepareWorktree: async () => {
        throw codedError("git_fetch_failed");
      }
    });

    await expect(executeCodeReview(harness.options)).rejects.toMatchObject({
      code: "git_fetch_failed"
    });

    await expect(runArtifacts(harness.artifactRoot)).resolves.toContain(
      "preflight.json"
    );
    await expect(readJson(harness.artifactRoot, "error.json")).resolves.toMatchObject({
      code: "git_fetch_failed"
    });
  });

  it("writes preflight when worktree_create_failed occurs after preflight", async () => {
    const harness = await createHarness({
      prepareWorktree: async () => {
        throw codedError("worktree_create_failed");
      }
    });

    await expect(executeCodeReview(harness.options)).rejects.toMatchObject({
      code: "worktree_create_failed"
    });

    await expect(runArtifacts(harness.artifactRoot)).resolves.toContain(
      "preflight.json"
    );
  });

  it("writes preflight, workspace when available, and error for head_sha_mismatch", async () => {
    const harness = await createHarness({
      prepareWorktree: async () => {
        throw codedError("head_sha_mismatch");
      }
    });

    await expect(executeCodeReview(harness.options)).rejects.toMatchObject({
      code: "head_sha_mismatch"
    });

    await expect(runArtifacts(harness.artifactRoot)).resolves.toEqual([
      "error.json",
      "invocation.json",
      "preflight.json",
      "run.json"
    ]);
  });

  it("writes workspace when head_sha_mismatch occurs after workspace creation", async () => {
    const harness = await createHarness({
      collectRepoContext: async () => {
        throw codedError("head_sha_mismatch");
      }
    });

    await expect(executeCodeReview(harness.options)).rejects.toMatchObject({
      code: "head_sha_mismatch"
    });

    await expect(runArtifacts(harness.artifactRoot)).resolves.toContain(
      "workspace.json"
    );
  });

  it("writes error for path_security_violation and never writes outside artifact root", async () => {
    const artifactRoot = await tempRoot("luna-orch-artifacts-");
    const outsideRoot = await tempRoot("luna-orch-outside-");
    const harness = await createHarness({
      artifactRoot,
      workspaceRoot: outsideRoot,
      prepareWorktree: async () => ({
        ...workspaceRecord,
        path: path.join(outsideRoot, "run")
      }),
      collectRepoContext: async () => {
        throw codedError("path_security_violation");
      }
    });

    await expect(executeCodeReview(harness.options)).rejects.toMatchObject({
      code: "path_security_violation"
    });

    await expect(readJson(artifactRoot, "error.json")).resolves.toMatchObject({
      code: "path_security_violation"
    });
    await expect(readdir(outsideRoot)).resolves.toEqual([]);
  });

  it("writes preflight, workspace, and error after context_collection_failed", async () => {
    const harness = await createHarness({
      collectRepoContext: async () => {
        throw codedError("context_collection_failed");
      }
    });

    await expect(executeCodeReview(harness.options)).rejects.toMatchObject({
      code: "context_collection_failed"
    });

    await expect(runArtifacts(harness.artifactRoot)).resolves.toEqual([
      "error.json",
      "invocation.json",
      "preflight.json",
      "run.json",
      "workspace.json"
    ]);
  });

  it("writes invalid-output/<node>.json and error.json after invalid agent output", async () => {
    const harness = await createHarness({
      reviewerOutput: { findings: "wrong shape" }
    });

    await expect(executeCodeReview(harness.options)).rejects.toMatchObject({
      code: "agent_output_invalid"
    });

    await expect(
      readJson(harness.artifactRoot, "invalid-output/code-reviewer.json")
    ).resolves.toMatchObject({
      node: "code-reviewer",
      attempts: 2
    });
    await expect(readJson(harness.artifactRoot, "error.json")).resolves.toMatchObject({
      code: "agent_output_invalid"
    });
  });

  it("preserves workspace on context collection failure when preserve_on_failure is true", async () => {
    const harness = await createHarness({
      preserveOnFailure: true,
      collectRepoContext: async () => {
        throw codedError("context_collection_failed");
      }
    });

    await expect(executeCodeReview(harness.options)).rejects.toMatchObject({
      code: "context_collection_failed"
    });

    await expect(readJson(harness.artifactRoot, "workspace.json")).resolves.toMatchObject({
      preserved: true,
      reason: "failure_preserved"
    });
    expect(harness.cleanupWorktree).not.toHaveBeenCalled();
  });

  it("cleans successful workspace when preserve_on_success is false and writes preserved false", async () => {
    const harness = await createHarness({ preserveOnSuccess: false });

    await executeCodeReview(harness.options);

    expect(harness.cleanupWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRecord,
        persistedWorkspaceRecord: workspaceRecord
      })
    );
    await expect(readJson(harness.artifactRoot, "workspace.json")).resolves.toMatchObject({
      preserved: false,
      reason: "success_cleanup"
    });
  });

  it("validates reviewer finding evidence before writing code-review-findings.json", async () => {
    const harness = await createHarness({
      reviewerOutput: {
        findings: [
          {
            ...findings.findings[0],
            confidence: "high",
            evidence: [
              {
                path: "src/auth.ts",
                line_start: 99,
                line_end: 99,
                quote: "missing"
              }
            ]
          }
        ]
      }
    });

    await executeCodeReview(harness.options);

    await expect(
      readJson(harness.artifactRoot, "code-review-findings.json")
    ).resolves.toMatchObject({
      findings: [
        {
          confidence: "low",
          evidence: []
        }
      ]
    });
  });
});
