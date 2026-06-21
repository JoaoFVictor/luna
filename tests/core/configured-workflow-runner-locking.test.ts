import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runConfiguredWorkflow } from "../../src/core/configured-workflow/runner.js";
import type { LunaEvent } from "../../src/core/observability/events.js";
import type { WorkspaceRecord } from "../../src/core/write-mode/types.js";
import {
  acceptedDecision,
  artifactPath,
  deferred,
  githubRun,
  invocation,
  jiraInvocation,
  jiraRun,
  pathExists,
  readJson,
  staticRunIdentity,
  withTimeout,
  writeAgent,
  writeBaseConfig,
  writeFullCodeReviewWorkflow,
  writeImplementationConfig,
  writeImplementationWorkflow,
  writePreflightWorkflow,
  writeReviewPlannerAgent,
  writeWorkflow
} from "./configured-workflow-runner-test-helpers.js";

async function writeLockingWorkflow(
  root: string,
  workflowId = "lock-review"
): Promise<void> {
  await mkdir(path.join(root, "workflows", workflowId), { recursive: true });
  await writeFile(
    path.join(root, "workflows", workflowId, "workflow.yaml"),
    [
      `id: ${workflowId}`,
      "type: workflow",
      "mode: git_managed_read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflows", workflowId, "graph.yaml"),
    [
      "nodes:",
      "  - id: workspace",
      "    type: built_in",
      "    uses: prepare_worktree",
      "    artifacts:",
      "      - path: workspace.json",
      "        source: $.steps.workspace",
      "        format: json",
      ""
    ].join("\n")
  );
}


async function writeAppConfigWithLocks(
  root: string,
  locks: { root?: string; timeoutMs?: number; staleAfterMs?: number }
): Promise<void> {
  await writeFile(
    path.join(root, "app.yaml"),
    [
      "workspace:",
      "  strategy: git_worktree",
      `  root: ${JSON.stringify(path.join(root, "workspaces"))}`,
      "  preserve_on_success: false",
      "  preserve_on_failure: true",
      "artifacts:",
      `  root: ${JSON.stringify(path.join(root, "artifacts"))}`,
      "locks:",
      ...(locks.root === undefined
        ? []
        : [`  root: ${JSON.stringify(locks.root)}`]),
      ...(locks.timeoutMs === undefined
        ? []
        : [`  timeout_ms: ${locks.timeoutMs}`]),
      ...(locks.staleAfterMs === undefined
        ? []
        : [`  stale_after_ms: ${locks.staleAfterMs}`]),
      ""
    ].join("\n")
  );
}


async function writePolicyLockWorkflow(root: string): Promise<void> {
  await mkdir(path.join(root, "workflows", "policy-locks"), {
    recursive: true
  });
  await writeFile(
    path.join(root, "routing.yaml"),
    [
      "routes:",
      "  - name: policy-locks",
      "    when: {}",
      "    target:",
      "      type: workflow",
      "      id: policy-locks",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflows", "policy-locks", "workflow.yaml"),
    [
      "id: policy-locks",
      "type: workflow",
      "mode: git_managed_read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      "execution:",
      "  max_concurrency: 3",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflows", "policy-locks", "graph.yaml"),
    [
      "nodes:",
      "  - id: locked_a",
      "    type: built_in",
      "    uses: commit_changes",
      "    artifacts:",
      "      - path: locked-a.json",
      "        source: $.steps.locked_a",
      "        format: json",
      "  - id: unlocked",
      "    type: built_in",
      "    uses: preflight",
      "    artifacts:",
      "      - path: unlocked.json",
      "        source: $.steps.unlocked",
      "        format: json",
      "  - id: locked_b",
      "    type: built_in",
      "    uses: commit_changes",
      "    artifacts:",
      "      - path: locked-b.json",
      "        source: $.steps.locked_b",
      "        format: json",
      ""
    ].join("\n")
  );
}


describe("configured workflow runner", () => {
  it("creates lock manager with lock root resolved from projectRoot and app lock config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-project-root-"));

    try {
      await writeBaseConfig(root, "lock-options");
      await writeAppConfigWithLocks(root, {
        root: "locks/app",
        timeoutMs: 3456,
        staleAfterMs: 9000
      });
      await writePreflightWorkflow(root);

      const lockManagerFactory = vi.fn(() => ({
        acquire: vi.fn(async () => async () => undefined)
      }));

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        projectRoot,
        runtimeRunId: "flue-lock",
        dependencies: {
          createRunIdentity: staticRunIdentity({
            ...githubRun,
            flue_run_id: "flue-lock"
          }),
          lockManagerFactory,
          runBuiltInStep: vi.fn(async () => ({ status: "ok" }))
        }
      });

      expect(result.status).toBe("success");
      expect(lockManagerFactory).toHaveBeenCalledWith({
        root: path.join(projectRoot, "locks/app"),
        runId: "run-1",
        runtimeRunId: "flue-lock",
        timeoutMs: 3456,
        staleAfterMs: 9000,
        observability: expect.any(Object)
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("acquires repository locks for repository-sensitive built-ins before execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "lock-review");
      await writeLockingWorkflow(root);

      const events: string[] = [];
      const workspace: WorkspaceRecord = {
        run_id: "run-1",
        path: path.join(root, "workspaces", "run-1"),
        preserved: true,
        reason: "prepared"
      };

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          lockManagerFactory: () => ({
            acquire: async (resource) => {
              events.push(`acquire:${resource}`);
              return async () => {
                events.push(`release:${resource}`);
              };
            }
          }),
          runBuiltInStep: vi.fn(async ({ uses }: { uses: string }) => {
            events.push(`run:${uses}`);
            return workspace;
          }),
          cleanupWorktree: vi.fn(async ({ workspaceRecord }) => ({
            ...workspaceRecord,
            preserved: false,
            reason: "success_cleanup"
          }))
        }
      });

      expect(result.status).toBe("success");
      expect(events).toEqual([
        "acquire:repository:repo",
        "run:prepare_worktree",
        "release:repository:repo",
        "acquire:repository:repo",
        "release:repository:repo"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes repository-sensitive sections without reducing global concurrency to one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "policy-locks");
      await writePolicyLockWorkflow(root);

      let activeRepositoryLocks = 0;
      let maxActiveRepositoryLocks = 0;
      let activeSteps = 0;
      let maxActiveSteps = 0;
      const lockTails = new Map<string, Promise<void>>();
      const events: string[] = [];
      const unlockedStepStarted = deferred();
      let firstLockedStepStarted = false;

      const resultPromise = runConfiguredWorkflow({
        invocation,
        configRoot: root,
        dependencies: {
          createRunIdentity: staticRunIdentity({
            ...githubRun,
            workflow_id: "policy-locks"
          }),
          lockManagerFactory: () => ({
            acquire: async (resource) => {
              const previous = lockTails.get(resource) ?? Promise.resolve();
              let releaseQueuedLock!: () => void;
              const queuedLock = new Promise<void>((resolve) => {
                releaseQueuedLock = resolve;
              });
              lockTails.set(resource, previous.then(() => queuedLock));
              await previous;

              events.push(`acquire:${resource}`);
              activeRepositoryLocks += 1;
              maxActiveRepositoryLocks = Math.max(
                maxActiveRepositoryLocks,
                activeRepositoryLocks
              );

              return async () => {
                activeRepositoryLocks -= 1;
                events.push(`release:${resource}`);
                releaseQueuedLock();
              };
            }
          }),
          runBuiltInStep: vi.fn(async ({ uses }: { uses: string }) => {
            activeSteps += 1;
            maxActiveSteps = Math.max(maxActiveSteps, activeSteps);
            events.push(`start:${uses}`);

            if (uses === "commit_changes" && !firstLockedStepStarted) {
              firstLockedStepStarted = true;
              await withTimeout(
                unlockedStepStarted.promise,
                500,
                "unlocked workflow step did not run while repository lock was held"
              );
            }

            if (uses === "preflight") {
              unlockedStepStarted.resolve();
            }

            events.push(`finish:${uses}`);
            activeSteps -= 1;

            if (uses === "commit_changes") {
              return {
                enabled: true,
                skipped: false,
                commit_sha: `abc123-${events.length}`,
                branch: "feature/abc-123"
              };
            }

            return { uses };
          })
        }
      });

      const result = await resultPromise;

      expect(result.status).toBe("success");
      expect(events).toContain("start:commit_changes");
      expect(events).toContain("start:preflight");
      expect(maxActiveSteps).toBeGreaterThan(1);
      expect(maxActiveRepositoryLocks).toBe(1);
      expect(
        events.filter((event) => event === "acquire:repository:repo")
      ).toHaveLength(2);
      await expect(
        readJson(root, "policy-locks", "run-1", "locked-a.json")
      ).resolves.toMatchObject({
        enabled: true,
        skipped: false,
        branch: "feature/abc-123"
      });
      await expect(
        readJson(root, "policy-locks", "run-1", "locked-b.json")
      ).resolves.toMatchObject({
        enabled: true,
        skipped: false,
        branch: "feature/abc-123"
      });
      await expect(
        readJson(root, "policy-locks", "run-1", "unlocked.json")
      ).resolves.toEqual({ uses: "preflight" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("acquires repository lock before cleanup can remove a worktree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "lock-review");
      await writeLockingWorkflow(root);

      const events: string[] = [];
      const workspace: WorkspaceRecord = {
        run_id: "run-1",
        path: path.join(root, "workspaces", "run-1"),
        preserved: true,
        reason: "prepared"
      };

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          lockManagerFactory: () => ({
            acquire: async (resource) => {
              events.push(`acquire:${resource}`);
              return async () => {
                events.push(`release:${resource}`);
              };
            }
          }),
          runBuiltInStep: vi.fn(async ({ uses }: { uses: string }) => {
            events.push(`run:${uses}`);
            return workspace;
          }),
          cleanupWorktree: vi.fn(async ({ workspaceRecord }) => {
            events.push("cleanup");
            return {
              ...workspaceRecord,
              preserved: false,
              reason: "success_cleanup"
            };
          })
        }
      });

      expect(result.status).toBe("success");
      expect(events).toEqual([
        "acquire:repository:repo",
        "run:prepare_worktree",
        "release:repository:repo",
        "acquire:repository:repo",
        "cleanup",
        "release:repository:repo"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses workflow lock timeout over app lock timeout when creating the manager", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-project-root-"));

    try {
      await writeBaseConfig(root, "lock-options");
      await writeAppConfigWithLocks(root, {
        timeoutMs: 1111,
        staleAfterMs: 12000
      });
      await writePreflightWorkflow(root, "lock-options", [
        "execution:",
        "  lock_timeout_ms: 2222"
      ]);

      const lockManagerFactory = vi.fn(() => ({
        acquire: vi.fn(async () => async () => undefined)
      }));

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        projectRoot,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          lockManagerFactory,
          runBuiltInStep: vi.fn(async () => ({ status: "ok" }))
        }
      });

      expect(result.status).toBe("success");
      expect(lockManagerFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          root: path.join(projectRoot, ".luna", "locks"),
          timeoutMs: 2222,
          staleAfterMs: 12000
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

});
