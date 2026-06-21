import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConfiguredWorkflow } from "../../src/core/configured-workflow/runner.js";
import { runGit } from "../../src/core/git.js";
import { collectRepoContext } from "../../src/core/repo-context-collector.js";
import type {
  AcceptanceDecision,
  CodeReviewFindings,
  Invocation,
  ReviewPlan
} from "../../src/core/types.js";
import {
  createRealGitReviewFixture,
  type RealGitReviewFixture
} from "../fixtures/git-repo.js";

const repoRoot = process.cwd();
const runId = "20260618t120000z-octo-hello-pr-123-a1";
const implementationRunId = "20260618t120000z-jira-abc-123-a1";

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

const acceptedImplementationDecision: AcceptanceDecision = {
  status: "accepted",
  summary: "Implementation accepted.",
  blocking_reasons: [],
  recommended_action: "approve"
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

async function writeExplicitTargetRouting(configRoot: string): Promise<void> {
  await writeFile(
    path.join(configRoot, "routing.yaml"),
    [
      "routes:",
      "  - name: explicit-target",
      "    when:",
      "      has_target: true",
      "    use_target_from_input: true",
      ""
    ].join("\n")
  );
}

async function writeImplementationConfig(configRoot: string): Promise<void> {
  await writeFile(
    path.join(configRoot, "implementation.yaml"),
    [
      "implementation:",
      "  branch_pattern: feature/{slug}",
      "  commit:",
      "    enabled: false",
      "  push:",
      "    enabled: false",
      "    remote: origin",
      "  change_request:",
      "    enabled: false",
      "    provider: github",
      "    draft: true",
      "    base_ref: main",
      "  sandbox:",
      "    type: trusted_host_local",
      "    env_allowlist: []",
      "  validation:",
      "    repair_attempts: 1",
      "    max_output_bytes: 200000",
      "    commands:",
      "      - cmd: npm",
      "        args: [\"test\"]",
      "        timeout_ms: 120000",
      ""
    ].join("\n")
  );
}

function sharedExclusiveLockManager(): {
  factory: (options: { runId: string }) => {
    acquire: (resource: string) => Promise<() => Promise<void>>;
  };
  events: string[];
  maxActiveLocks: () => number;
} {
  const lockTails = new Map<string, Promise<void>>();
  const events: string[] = [];
  let activeLocks = 0;
  let maxActiveLocks = 0;

  return {
    events,
    maxActiveLocks: () => maxActiveLocks,
    factory: ({ runId }) => ({
      acquire: async (resource) => {
        const previous = lockTails.get(resource) ?? Promise.resolve();
        let releaseQueuedLock!: () => void;
        const queuedLock = new Promise<void>((resolve) => {
          releaseQueuedLock = resolve;
        });
        lockTails.set(resource, previous.then(() => queuedLock));
        await previous;

        activeLocks += 1;
        maxActiveLocks = Math.max(maxActiveLocks, activeLocks);
        events.push(`acquire:${runId}:${resource}`);

        return async () => {
          activeLocks -= 1;
          events.push(`release:${runId}:${resource}`);
          releaseQueuedLock();
        };
      }
    })
  };
}

function concurrentBarrier(expected: number, message: string): {
  enter: () => Promise<number>;
  maxWaiting: () => number;
} {
  let waiting = 0;
  let maxWaiting = 0;
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    maxWaiting: () => maxWaiting,
    enter: async () => {
      waiting += 1;
      maxWaiting = Math.max(maxWaiting, waiting);
      if (waiting === expected) {
        release?.();
      }

      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          released,
          new Promise<void>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error(message)), 500);
          })
        ]);
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      }

      return waiting;
    }
  };
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
    const artifactRoot = await mkdtemp(
      path.join(tmpdir(), "luna-e2e-artifacts-")
    );
    const workspaceRoot = await mkdtemp(
      path.join(tmpdir(), "luna-e2e-worktrees-")
    );
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
          workflow_id: "code-review",
          attempt: 1,
          source: "github",
          event: "pull_request",
          action: "selected",
          route_target: { type: "workflow", id: "code-review" },
          subject: { type: "pull_request", id: "42" },
          started_at: "2026-06-20T00:00:00.000Z"
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

  it("runs code review and implementation workflows concurrently while repository-sensitive nodes share locks", async () => {
    const fixture = await createRealGitReviewFixture();
    fixtures.push(fixture);
    const configRoot = await mkdtemp(path.join(tmpdir(), "luna-e2e-config-"));
    const artifactRoot = await mkdtemp(path.join(tmpdir(), "luna-e2e-artifacts-"));
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "luna-e2e-worktrees-"));
    tempRoots.push(configRoot, artifactRoot, workspaceRoot);
    await writeConfigRoot({ configRoot, artifactRoot, workspaceRoot, fixture });
    await writeExplicitTargetRouting(configRoot);
    await writeImplementationConfig(configRoot);

    const locks = sharedExclusiveLockManager();
    const workflowOverlap = concurrentBarrier(
      2,
      "code review and implementation workflows did not overlap"
    );
    const implementationInvocation: Invocation = {
      version: "2026-06",
      source: "jira",
      event: "issue",
      action: "selected",
      target: { type: "workflow", id: "implementation" },
      repository: {
        provider: "github",
        owner: fixture.repository.owner,
        name: fixture.repository.name
      },
      subject: {
        type: "jira_issue",
        id: "ABC-123",
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

    const [codeReviewResult, implementationResult] = await Promise.all([
      runConfiguredWorkflow({
        invocation: {
          ...fixture.invocation,
          target: { type: "workflow", id: "code-review" }
        },
        configRoot,
        workflowsRoot: path.join(repoRoot, "workflows"),
        agentsRoot: path.join(repoRoot, "agents"),
        dependencies: {
          createRunIdentity: () => ({
            run_id: runId,
            workflow_id: "code-review",
            attempt: 1,
            source: "github",
            event: "pull_request",
            action: "selected",
            route_target: { type: "workflow", id: "code-review" },
            subject: { type: "pull_request", id: "123" },
            started_at: "2026-06-20T00:00:00.000Z"
          }),
          lockManagerFactory: locks.factory,
          builtInStepDependencies: {
            collectRepoContext: async (options) =>
              await collectRepoContext(options)
          },
          runAgentStep: async ({ agent }) => {
            if (agent.id === "review-planner") {
              await workflowOverlap.enter();
              return reviewPlan;
            }

            if (agent.id === "change-reviewer") {
              return findings;
            }

            return acceptance;
          }
        }
      }),
      runConfiguredWorkflow({
        invocation: implementationInvocation,
        configRoot,
        workflowsRoot: path.join(repoRoot, "workflows"),
        agentsRoot: path.join(repoRoot, "agents"),
        dependencies: {
          createRunIdentity: () => ({
            run_id: implementationRunId,
            workflow_id: "implementation",
            attempt: 1,
            source: "jira",
            event: "issue",
            action: "selected",
            route_target: { type: "workflow", id: "implementation" },
            subject: { type: "jira_issue", id: "ABC-123" },
            started_at: "2026-06-20T00:00:00.000Z"
          }),
          lockManagerFactory: locks.factory,
          runBuiltInStep: async ({ uses, state }) => {
            if (uses === "preflight") {
              await workflowOverlap.enter();
              return { status: "ok" };
            }

            if (uses === "prepare_implementation_worktree") {
              const run = state.run as { run_id: string };

              return {
                run_id: run.run_id,
                path: path.join(workspaceRoot, "implementation", run.run_id),
                preserved: true,
                reason: "created",
                repository_id: fixture.repository.id,
                remote: "origin",
                base_ref: "main",
                base_sha: fixture.base_sha,
                branch: `feature/abc-123-${run.run_id}`
              };
            }

            if (uses === "collect_task_context") {
              return {
                implementation_title: "ABC-123: Fix checkout validation",
                implementation_subject: {
                  key: "ABC-123",
                  title: "Fix checkout validation"
                },
                jira: {
                  issue_key: "ABC-123",
                  summary: "Fix checkout validation",
                  description: "Reject invalid checkout payloads."
                }
              };
            }

            if (uses === "collect_worktree_diff") {
              return { files: [] };
            }

            if (uses === "record_implementation_validation") {
              return { passed: true };
            }

            if (uses === "record_acceptance_decision") {
              return acceptedImplementationDecision;
            }

            if (uses === "commit_changes") {
              return { enabled: false, skipped: true, reason: "disabled" };
            }

            if (uses === "push_branch") {
              return { enabled: false, skipped: true, reason: "disabled" };
            }

            if (uses === "open_change_request") {
              return { enabled: false, skipped: true, reason: "disabled" };
            }

            if (uses === "final_implementation_report") {
              return {
                json: { status: "completed_with_skips", worktree: state.workspace },
                markdown: "# Implementation\n"
              };
            }

            return {};
          },
          runAgentStep: async ({ agent }) =>
            agent.id === "implementation-planner"
              ? { summary: "Plan", steps: ["Edit"], risks: [] }
              : acceptedImplementationDecision,
          runAgentLoopStep: async () => ({
            status: "passed",
            attempts_exhausted: false,
            attempts: [],
            validation: { passed: true },
            final_validation: { passed: true },
            result: { status: "passed" }
          })
        }
      })
    ]);

    expect(codeReviewResult.status).toBe("success");
    expect(implementationResult.status).toBe("success");
    expect(workflowOverlap.maxWaiting()).toBe(2);
    expect(locks.maxActiveLocks()).toBe(1);
    expect(locks.events).toEqual(
      expect.arrayContaining([
        `acquire:${runId}:repository:${fixture.repository.id}`,
        `acquire:${implementationRunId}:repository:${fixture.repository.id}`
      ])
    );
    await expect(
      pathExists(
        path.join(artifactRoot, "code-review", runId, "final-report.json")
      )
    ).resolves.toBe(true);
    await expect(
      pathExists(
        path.join(
          artifactRoot,
          "implementation",
          implementationRunId,
          "final-report.json"
        )
      )
    ).resolves.toBe(true);
  });
});
