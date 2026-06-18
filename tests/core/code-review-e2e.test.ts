import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeCodeReview } from "../../src/core/code-review-orchestrator.js";
import { runGit } from "../../src/core/git.js";
import type {
  AcceptanceDecision,
  AppConfig,
  CodeReviewFindings,
  ReviewPlan,
  RoutingConfig
} from "../../src/core/types.js";
import {
  createRealGitReviewFixture,
  type RealGitReviewFixture
} from "../fixtures/git-repo.js";

const runId = "20260618t120000z-octo-hello-pr-123-a1";

const routing: RoutingConfig = {
  routes: [
    {
      name: "github-pr",
      when: {},
      target: { type: "workflow", id: "code-review" }
    }
  ]
};

const reviewPlan: ReviewPlan = {
  summary: "Review a real Git fixture.",
  focus_areas: ["changed files"],
  files_to_review: ["review-target.ts"]
};

const findings: CodeReviewFindings = {
  findings: [
    {
      title: "Answer changed",
      severity: "info",
      confidence: "high",
      description: "The answer changed in the fixture.",
      evidence: [
        {
          path: "review-target.ts",
          line_start: 1,
          line_end: 1,
          quote: "42"
        }
      ],
      recommendation: "Keep the fixture deterministic."
    }
  ],
  summary: "One fixture finding."
};

const acceptance: AcceptanceDecision = {
  decision: "comment",
  summary: "Fixture review completed.",
  blocking_findings: []
};

async function readJson<T>(root: string, name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(root, runId, name), "utf8")) as T;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("code review end-to-end with real Git", () => {
  const fixtures: RealGitReviewFixture[] = [];
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it("creates a worktree, writes repo context and final artifacts, then cleans up on success", async () => {
    const fixture = await createRealGitReviewFixture();
    fixtures.push(fixture);
    const artifactRoot = await mkdtemp(path.join(tmpdir(), "luna-e2e-artifacts-"));
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "luna-e2e-worktrees-"));
    tempRoots.push(artifactRoot, workspaceRoot);
    const app: AppConfig = {
      workspace: {
        strategy: "git_worktree",
        root: workspaceRoot,
        preserve_on_success: false,
        preserve_on_failure: false
      },
      artifacts: {
        root: artifactRoot
      }
    };

    const result = await executeCodeReview({
      invocation: fixture.invocation,
      configs: {
        app,
        repositories: {
          repositories: [fixture.repository]
        },
        routing
      },
      nodes: {
        reviewPlanner: {
          execute: async () => reviewPlan
        },
        codeReviewer: {
          execute: async () => findings
        },
        acceptanceReviewer: {
          execute: async () => acceptance
        }
      },
      dependencies: {
        createRunIdentity: () => ({
          run_id: runId,
          target: "github_pr",
          started_at: "2026-06-18T12:00:00.000Z"
        })
      }
    });

    const repoContext = await readJson<{
      files: Array<{ path: string; patch: string | null }>;
    }>(artifactRoot, "repo-context.json");
    const workspace = await readJson<{ path: string; preserved: boolean; reason: string }>(
      artifactRoot,
      "workspace.json"
    );

    expect(result.status).toBe("success");
    expect(repoContext.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "review-target.ts",
          patch: expect.stringContaining("+export const answer = 42;")
        })
      ])
    );
    await expect(pathExists(path.join(artifactRoot, runId, "final-report.json"))).resolves.toBe(
      true
    );
    await expect(pathExists(path.join(artifactRoot, runId, "final-report.md"))).resolves.toBe(
      true
    );
    expect(workspace.path).toContain(path.join(workspaceRoot, fixture.repository.id));
    expect(workspace).toMatchObject({
      preserved: false,
      reason: "success_cleanup"
    });
    await expect(pathExists(workspace.path)).resolves.toBe(false);
    await expect(
      runGit(fixture.repository.path, ["worktree", "list", "--porcelain"])
    ).resolves.not.toContain(workspace.path);
  });
});
