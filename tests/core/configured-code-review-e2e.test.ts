import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConfiguredWorkflow } from "../../src/core/configured-workflow-runner.js";
import { runGit } from "../../src/core/git.js";
import { collectRepoContext } from "../../src/core/repo-context-collector.js";
import type {
  AcceptanceDecision,
  CodeReviewFindings,
  ReviewPlan
} from "../../src/core/types.js";
import {
  createRealGitReviewFixture,
  type RealGitReviewFixture
} from "../fixtures/git-repo.js";

const runId = "20260618t120000z-octo-hello-pr-123-a1";

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
  status: "needs_human_review",
  summary: "Fixture review completed.",
  blocking_reasons: [],
  recommended_action: "comment"
};

async function readJson<T>(root: string, name: string): Promise<T> {
  return JSON.parse(
    await readFile(path.join(root, "code-review", runId, name), "utf8")
  ) as T;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeConfigRoot({
  configRoot,
  artifactRoot,
  workspaceRoot,
  fixture
}: {
  configRoot: string;
  artifactRoot: string;
  workspaceRoot: string;
  fixture: RealGitReviewFixture;
}): Promise<void> {
  await writeFile(
    path.join(configRoot, "app.yaml"),
    [
      "workspace:",
      "  strategy: git_worktree",
      `  root: ${JSON.stringify(workspaceRoot)}`,
      "  preserve_on_success: false",
      "  preserve_on_failure: false",
      "artifacts:",
      `  root: ${JSON.stringify(artifactRoot)}`,
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(configRoot, "repositories.yaml"),
    [
      "repositories:",
      `  - id: ${fixture.repository.id}`,
      "    provider: github",
      `    owner: ${fixture.repository.owner}`,
      `    name: ${fixture.repository.name}`,
      `    path: ${JSON.stringify(fixture.repository.path)}`,
      `    remote: ${fixture.repository.remote}`,
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(configRoot, "routing.yaml"),
    [
      "routes:",
      "  - name: code-review",
      "    when: {}",
      "    target:",
      "      type: workflow",
      "      id: code-review",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(configRoot, "models.yaml"),
    [
      "model_profiles:",
      "  default:",
      "    model: test/default",
      "    reasoning_effort: medium",
      "  deep:",
      "    model: test/deep",
      "    reasoning_effort: high",
      ""
    ].join("\n")
  );
}

describe("configured code review workflow end-to-end with real Git", () => {
  const fixtures: RealGitReviewFixture[] = [];
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it("runs the YAML workflow, writes repo context and final artifacts, then cleans up on success", async () => {
    const fixture = await createRealGitReviewFixture();
    fixtures.push(fixture);
    const configRoot = await mkdtemp(path.join(tmpdir(), "luna-e2e-config-"));
    const artifactRoot = await mkdtemp(path.join(tmpdir(), "luna-e2e-artifacts-"));
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "luna-e2e-worktrees-"));
    tempRoots.push(configRoot, artifactRoot, workspaceRoot);
    await writeConfigRoot({ configRoot, artifactRoot, workspaceRoot, fixture });
    const collectedRepositoryPaths: string[] = [];

    const result = await runConfiguredWorkflow({
      invocation: fixture.invocation,
      configRoot,
      workflowsRoot: "workflows",
      agentsRoot: "agents",
      dependencies: {
        createRunIdentity: () => ({
          run_id: runId,
          attempt: 1,
          source: "github",
          event: "pull_request",
          action: "selected",
          route_target: { type: "workflow", id: "code-review" },
          subject: { type: "pull_request", id: "42" }
        }),
        builtInStepDependencies: {
          collectRepoContext: async (options) => {
            collectedRepositoryPaths.push(options.repository.path);
            return await collectRepoContext(options);
          }
        },
        runAgentStep: async ({ agent }) => {
          if (agent.id === "review-planner") {
            return reviewPlan;
          }

          if (agent.id === "change-reviewer") {
            return findings;
          }

          return acceptance;
        }
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
    await expect(
      pathExists(path.join(artifactRoot, "code-review", runId, "final-report.json"))
    ).resolves.toBe(true);
    await expect(
      pathExists(path.join(artifactRoot, "code-review", runId, "final-report.md"))
    ).resolves.toBe(true);
    expect(workspace.path).toContain(path.join(workspaceRoot, fixture.repository.id));
    expect(collectedRepositoryPaths).toEqual([workspace.path]);
    expect(collectedRepositoryPaths[0]).not.toBe(fixture.repository.path);
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
