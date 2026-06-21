import { describe, expect, it, vi } from "vitest";
import {
  runWorkflowSchedule,
  schedulerStepFailed,
  splitDeferredFinalReportNodes
} from "../../src/core/workflow-scheduler.js";
import { createLunaObservability } from "../../src/core/observability/luna-observability.js";
import type { LunaObservabilityEvent } from "../../src/core/observability/events.js";
import type { WorkflowNode } from "../../src/core/workflow-definition.js";
import type { SchedulerWorkflowState } from "../../src/core/workflow-state.js";

type BuiltInWorkflowNode = Extract<WorkflowNode, { type: "built_in" }>;

function baseState(): SchedulerWorkflowState {
  return {
    invocation: { version: "2026-06", source: "github", event: "pull_request" },
    config: {},
    repository: {
      id: "repo",
      provider: "github",
      owner: "o",
      name: "r",
      path: "/repo",
      remote: "origin"
    },
    run: {
      run_id: "run-1",
      workflow_id: "code-review",
      attempt: 1,
      source: "github",
      event: "pull_request",
      started_at: "2026-06-18T00:00:00.000Z"
    },
    workflow: { id: "code-review", mode: "git_managed_read_only" },
    workspaceRoot: ".workspaces",
    steps: {}
  };
}

function builtInNode(id: string, after?: string[]): BuiltInWorkflowNode {
  return {
    id,
    type: "built_in",
    uses: "preflight",
    ...(after === undefined ? {} : { after })
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

async function settlesTrueWithin(
  promise: Promise<unknown>,
  timeoutMs = 50
): Promise<boolean> {
  return await Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs);
    })
  ]);
}

describe("workflow scheduler", () => {
  it("keeps parallel scheduler runs successful when an optional observability sink fails", async () => {
    const requiredEvents: LunaObservabilityEvent[] = [];
    const started: string[] = [];
    const observability = createLunaObservability({
      run: { id: "run-1" },
      workflow: { id: "code-review" },
      sinks: [
        {
          id: "optional-test",
          required: false,
          append: () => {
            throw new Error("optional sink offline");
          }
        },
        {
          id: "required-test",
          required: true,
          append: (event) => {
            requiredEvents.push(event);
          }
        }
      ]
    });

    const result = await runWorkflowSchedule({
      nodes: [builtInNode("a"), builtInNode("b")],
      state: baseState(),
      execution: { max_concurrency: 2 },
      observability,
      runNode: async ({ node }) => {
        started.push(node.id);
        return { id: node.id };
      },
      writePlannedArtifacts: vi.fn(async () => undefined),
      builtInMetadata: () => ({})
    });

    expect(result.status).toBe("success");
    expect(started).toEqual(expect.arrayContaining(["a", "b"]));
    expect(requiredEvents.some((event) =>
      event.event === "luna.observability.sink.warning"
    )).toBe(true);
  });

  it("stops before selecting the next batch after a required observability sink hard failure", async () => {
    const events: LunaObservabilityEvent[] = [];
    const requiredSinkFailure = new Error("required sink offline");
    const observability = createLunaObservability({
      run: { id: "run-1" },
      workflow: { id: "code-review" },
      sinks: [
        {
          id: "required-test",
          required: true,
          append: (event) => {
            events.push(event);
            if (event.event === "luna.scheduler.step.finished") {
              throw requiredSinkFailure;
            }
          }
        }
      ]
    });
    const started: string[] = [];

    await expect(
      runWorkflowSchedule({
        nodes: [builtInNode("a"), builtInNode("b", ["a"])],
        state: baseState(),
        execution: { max_concurrency: 2 },
        observability,
        runNode: async ({ node }) => {
          started.push(node.id);
          return { id: node.id };
        },
        writePlannedArtifacts: vi.fn(async () => undefined),
        builtInMetadata: () => ({})
      })
    ).rejects.toMatchObject({
      code: "observability_append_failed",
      hardFailure: true,
      sinkId: "required-test"
    });

    expect(started).toEqual(["a"]);
    expect(events.map((event) => event.event)).toContain(
      "luna.scheduler.step.started"
    );
    expect(events.map((event) => event.event)).toContain(
      "luna.scheduler.step.finished"
    );
  });

  it("preserves captured workspace on required observability hard failure after node success", async () => {
    const workspace = {
      run_id: "run-1",
      path: "/tmp/luna-workspace",
      preserved: true,
      reason: "prepared"
    };
    const observability = createLunaObservability({
      run: { id: "run-1" },
      workflow: { id: "code-review" },
      sinks: [
        {
          id: "required-test",
          required: true,
          append: (event) => {
            if (event.event === "luna.scheduler.step.finished") {
              throw new Error("required sink offline");
            }
          }
        }
      ]
    });

    await expect(
      runWorkflowSchedule({
        nodes: [{ id: "workspace", type: "built_in", uses: "prepare_worktree" }],
        state: baseState(),
        execution: { max_concurrency: 1 },
        observability,
        runNode: async () => workspace,
        writePlannedArtifacts: vi.fn(async () => undefined),
        builtInMetadata: () => ({ capturesWorkspace: true })
      })
    ).rejects.toMatchObject({
      code: "observability_append_failed",
      workspaceRecord: workspace
    });
  });

  it("runs ready nodes sequentially when max_concurrency is 1", async () => {
    const callOrder: string[] = [];
    const nodes = [builtInNode("a"), builtInNode("b", ["a"])];

    const result = await runWorkflowSchedule({
      nodes,
      state: baseState(),
      execution: { max_concurrency: 1 },
      runNode: async ({ node }) => {
        callOrder.push(node.id);
        return { id: node.id };
      },
      writePlannedArtifacts: vi.fn(async () => undefined),
      builtInMetadata: () => ({})
    });

    expect(result).toEqual({
      status: "success",
      steps: {
        a: { id: "a" },
        b: { id: "b" }
      }
    });
    expect(callOrder).toEqual(["a", "b"]);
  });

  it("runs independent nodes concurrently when max_concurrency is greater than 1", async () => {
    const started: string[] = [];
    const bothStarted = deferred();
    const release = deferred();

    const schedule = runWorkflowSchedule({
      nodes: [builtInNode("a"), builtInNode("b")],
      state: baseState(),
      execution: { max_concurrency: 2 },
      runNode: async ({ node }) => {
        started.push(node.id);
        if (started.length === 2) {
          bothStarted.resolve();
        }
        await release.promise;
        return { id: node.id };
      },
      writePlannedArtifacts: vi.fn(async () => undefined),
      builtInMetadata: () => ({})
    });

    expect(await settlesTrueWithin(bothStarted.promise)).toBe(true);
    expect(started).toEqual(["a", "b"]);
    release.resolve();

    const result = await schedule;
    expect(result.status).toBe("success");
  });

  it("falls back to sequential execution for invalid direct max_concurrency", async () => {
    const running: string[] = [];
    const completed: string[] = [];

    const result = await runWorkflowSchedule({
      nodes: [builtInNode("a"), builtInNode("b")],
      state: baseState(),
      execution: { max_concurrency: Number.NaN },
      runNode: async ({ node }) => {
        expect(running).toHaveLength(0);
        running.push(node.id);
        await Promise.resolve();
        completed.push(node.id);
        running.pop();
        return { id: node.id };
      },
      writePlannedArtifacts: vi.fn(async () => undefined),
      builtInMetadata: () => ({})
    });

    expect(result.status).toBe("success");
    expect(completed).toEqual(["a", "b"]);
  });

  it("does not run duplicate artifact writers concurrently", async () => {
    const firstBatchStarted: string[] = [];
    const firstBatchReady = deferred();
    const release = deferred();

    const schedule = runWorkflowSchedule({
      nodes: [
        {
          ...builtInNode("a"),
          artifacts: [{ path: "shared.json", source: "$.steps.a", format: "json", required: true }]
        },
        {
          ...builtInNode("b"),
          artifacts: [{ path: "shared.json", source: "$.steps.b", format: "json", required: true }]
        },
        {
          ...builtInNode("c"),
          artifacts: [{ path: "other.json", source: "$.steps.c", format: "json", required: true }]
        }
      ],
      state: baseState(),
      execution: { max_concurrency: 3 },
      runNode: async ({ node }) => {
        firstBatchStarted.push(node.id);
        if (
          firstBatchStarted.includes("a") &&
          firstBatchStarted.includes("c")
        ) {
          firstBatchReady.resolve();
        }
        await release.promise;
        return { id: node.id };
      },
      writePlannedArtifacts: vi.fn(async () => undefined),
      builtInMetadata: () => ({})
    });

    expect(await settlesTrueWithin(firstBatchReady.promise)).toBe(true);
    expect(firstBatchStarted).toEqual(["a", "c"]);
    release.resolve();

    const result = await schedule;
    expect(result.status).toBe("success");
    expect(firstBatchStarted).toEqual(["a", "c", "b"]);
  });

  it("does not run workspace-capturing nodes concurrently", async () => {
    const started: string[] = [];
    const firstStarted = deferred();
    const release = deferred();

    const schedule = runWorkflowSchedule({
      nodes: [
        { id: "workspace_a", type: "built_in", uses: "prepare_worktree" },
        { id: "workspace_b", type: "built_in", uses: "prepare_worktree" },
        builtInNode("free")
      ],
      state: baseState(),
      execution: { max_concurrency: 3 },
      runNode: async ({ node }) => {
        started.push(node.id);
        if (
          started.includes("workspace_a") &&
          started.includes("free") &&
          !started.includes("workspace_b")
        ) {
          firstStarted.resolve();
        }
        await release.promise;
        return {
          run_id: "run-1",
          path: `/tmp/${node.id}`,
          preserved: true,
          reason: "prepared"
        };
      },
      writePlannedArtifacts: vi.fn(async () => undefined),
      builtInMetadata: (node) =>
        node.id.startsWith("workspace_") ? { capturesWorkspace: true } : {}
    });

    expect(await settlesTrueWithin(firstStarted.promise)).toBe(true);
    expect(started).toEqual(["workspace_a", "free"]);
    release.resolve();

    const result = await schedule;
    expect(result.status).toBe("failed");
    expect(started).toEqual(["workspace_a", "free", "workspace_b"]);
    expect(result.steps.workspace_b).toMatchObject({
      status: "failed",
      details: {
        cause_code: "workflow_workspace_duplicate",
        step_id: "workspace_b"
      }
    });
  });

  it("allows parallel ready nodes but serializes shared repository locks", async () => {
    const events: string[] = [];
    const releaseFirstLock = deferred();
    const secondLockReleased = deferred();
    const freeNodeStarted = deferred();
    let activeRepositoryLock = false;

    const schedule = runWorkflowSchedule({
      nodes: [
        { id: "locked_a", type: "built_in", uses: "prepare_worktree" },
        { id: "locked_b", type: "built_in", uses: "prepare_worktree" },
        builtInNode("free")
      ],
      state: baseState(),
      execution: { max_concurrency: 3 },
      lockManager: {
        acquire: async (resource) => {
          events.push(`acquire:${resource}`);
          if (activeRepositoryLock) {
            await releaseFirstLock.promise;
          }
          activeRepositoryLock = true;

          return async () => {
            activeRepositoryLock = false;
            events.push(`release:${resource}`);
            releaseFirstLock.resolve();
            secondLockReleased.resolve();
          };
        }
      },
      runNode: async ({ node }) => {
        events.push(`run:${node.id}`);
        if (node.id === "free") {
          freeNodeStarted.resolve();
        }
        if (node.id === "locked_a") {
          await freeNodeStarted.promise;
        }
        return { id: node.id };
      },
      writePlannedArtifacts: vi.fn(async () => undefined),
      builtInMetadata: (node) =>
        node.id.startsWith("locked")
          ? { locks: [{ resource: "repository", mode: "exclusive" }] }
          : {}
    });

    expect(await settlesTrueWithin(freeNodeStarted.promise)).toBe(true);
    await secondLockReleased.promise;
    const result = await schedule;

    expect(result.status).toBe("success");
    expect(events.indexOf("run:free")).toBeLessThan(
      events.indexOf("release:repository:repo")
    );
    expect(events.indexOf("run:locked_b")).toBeGreaterThan(
      events.indexOf("release:repository:repo")
    );
  });

  it("keeps agent-like nodes effectively sequential while built-ins can share the batch", async () => {
    const started: string[] = [];
    const firstBatchReady = deferred();
    const release = deferred();

    const schedule = runWorkflowSchedule({
      nodes: [
        {
          id: "agent_a",
          type: "agent",
          agent: "reviewer",
          output_schema: "review"
        },
        builtInNode("preflight"),
        {
          id: "agent_b",
          type: "agent_loop",
          agent: "implementer",
          output_schema: "result",
          artifacts: [
            {
              path: "report.json",
              source: "$.steps.agent_b.report",
              format: "json",
              required: true
            }
          ],
          sandbox: {
            type: "trusted_host_local",
            cwd: ".",
            env_allowlist: []
          },
          validation: { commands: "npm test", max_output_bytes: 1024 },
          repair: { attempts: 1 }
        }
      ],
      state: baseState(),
      execution: { max_concurrency: 3 },
      runNode: async ({ node }) => {
        started.push(node.id);
        if (started.includes("agent_a") && started.includes("preflight")) {
          firstBatchReady.resolve();
        }
        await release.promise;
        return { id: node.id };
      },
      writePlannedArtifacts: vi.fn(async () => undefined),
      builtInMetadata: () => ({})
    });

    expect(await settlesTrueWithin(firstBatchReady.promise)).toBe(true);
    expect(started).toEqual(["agent_a", "preflight"]);
    release.resolve();

    const result = await schedule;
    expect(result.status).toBe("success");
    expect(started).toEqual(["agent_a", "preflight", "agent_b"]);
  });

  it("wraps repository-locked built-ins with repository lock", async () => {
    const events: string[] = [];
    await runWorkflowSchedule({
      nodes: [{ id: "prepare", type: "built_in", uses: "prepare_worktree" }],
      state: baseState(),
      execution: { max_concurrency: 1 },
      lockManager: {
        acquire: async (resource) => {
          events.push(`acquire:${resource}`);
          return async () => {
            events.push(`release:${resource}`);
          };
        }
      },
      runNode: async () => {
        events.push("run");
        return { ok: true };
      },
      writePlannedArtifacts: async () => undefined,
      builtInMetadata: () => ({
        locks: [{ resource: "repository", mode: "exclusive" }]
      })
    });

    expect(events).toEqual([
      "acquire:repository:repo",
      "run",
      "release:repository:repo"
    ]);
  });

  it("fails before execution when repository lock metadata cannot resolve a repository", async () => {
    const state = baseState();
    delete state.repository;

    await expect(
      runWorkflowSchedule({
        nodes: [{ id: "prepare", type: "built_in", uses: "prepare_worktree" }],
        state,
        execution: { max_concurrency: 1 },
        runNode: async () => ({ ok: true }),
        writePlannedArtifacts: async () => undefined,
        builtInMetadata: () => ({
          locks: [{ resource: "repository", mode: "exclusive" }]
        })
      })
    ).rejects.toMatchObject({ code: "lock_resource_missing" });
  });

  it("fails before execution when repository lock metadata has no lock manager", async () => {
    await expect(
      runWorkflowSchedule({
        nodes: [{ id: "prepare", type: "built_in", uses: "prepare_worktree" }],
        state: baseState(),
        execution: { max_concurrency: 1 },
        runNode: async () => ({ ok: true }),
        writePlannedArtifacts: async () => undefined,
        builtInMetadata: () => ({
          locks: [{ resource: "repository", mode: "exclusive" }]
        })
      })
    ).rejects.toMatchObject({ code: "lock_manager_missing" });
  });

  it("does not run sibling nodes when a selected lock preflight fails", async () => {
    const runNode = vi.fn(async () => ({ ok: true }));
    const writePlannedArtifacts = vi.fn(async () => undefined);

    const state = baseState();
    delete state.repository;

    await expect(
      runWorkflowSchedule({
        nodes: [builtInNode("locked"), builtInNode("free")],
        state,
        execution: { max_concurrency: 2 },
        lockManager: {
          acquire: async () => async () => undefined
        },
        runNode,
        writePlannedArtifacts,
        builtInMetadata: (node) =>
          node.id === "locked"
            ? { locks: [{ resource: "repository", mode: "exclusive" }] }
            : {}
      })
    ).rejects.toMatchObject({ code: "lock_resource_missing" });

    expect(runNode).not.toHaveBeenCalled();
    expect(writePlannedArtifacts).not.toHaveBeenCalled();
  });

  it("attempts every acquired release and preserves the node failure", async () => {
    const cause = new Error("node exploded") as Error & {
      releaseErrors?: unknown[];
    };
    const events: string[] = [];

    const result = await runWorkflowSchedule({
      nodes: [{ id: "prepare", type: "built_in", uses: "prepare_worktree" }],
      state: baseState(),
      execution: { max_concurrency: 1 },
      lockManager: {
        acquire: async () => {
          const releaseId = events.length;
          events.push(`acquire:${releaseId}`);
          return async () => {
            events.push(`release:${releaseId}`);
            if (releaseId === 1) {
              throw new Error("release failed");
            }
          };
        }
      },
      runNode: async () => {
        throw cause;
      },
      writePlannedArtifacts: async () => undefined,
      builtInMetadata: () => ({
        locks: [
          { resource: "repository", mode: "exclusive" },
          { resource: "repository", mode: "exclusive" }
        ]
      })
    });

    expect(result.status).toBe("failed");
    expect(result.steps.prepare).toMatchObject({
      status: "failed",
      code: "scheduler_step_failed",
      message: "node exploded"
    });
    expect(cause.releaseErrors).toHaveLength(1);
    expect(events).toEqual([
      "acquire:0",
      "acquire:1",
      "release:1",
      "release:0"
    ]);
  });

  it("fails the step when lock release fails after node success", async () => {
    const result = await runWorkflowSchedule({
      nodes: [{ id: "prepare", type: "built_in", uses: "prepare_worktree" }],
      state: baseState(),
      execution: { max_concurrency: 1 },
      lockManager: {
        acquire: async () => async () => {
          throw new Error("release failed");
        }
      },
      runNode: async () => ({ ok: true }),
      writePlannedArtifacts: async () => undefined,
      builtInMetadata: () => ({
        locks: [{ resource: "repository", mode: "exclusive" }]
      })
    });

    expect(result.status).toBe("failed");
    expect(result.steps.prepare).toMatchObject({
      status: "failed",
      code: "scheduler_step_failed",
      details: {
        step_id: "prepare",
        cause_code: "lock_release_failed"
      }
    });
  });

  it("rejects non-deferred nodes that depend on deferred final report nodes", () => {
    expect(() =>
      splitDeferredFinalReportNodes(
        [
          { id: "final", type: "built_in", uses: "final_code_review_report" },
          {
            id: "after_final",
            type: "built_in",
            uses: "preflight",
            after: ["final"]
          }
        ],
        (node) =>
          node.id === "final"
            ? { deferUntilAfterWorkspaceLifecycle: true }
            : {}
      )
    ).toThrow(expect.objectContaining({
      code: "workflow_deferred_dependency_invalid"
    }));
  });

  it("wraps node failures as scheduler step failures and skips dependents", async () => {
    const cause = new Error("node exploded") as Error & { code: string };
    cause.code = "node_exploded";
    const writePlannedArtifacts = vi.fn(async () => undefined);
    const events: LunaObservabilityEvent[] = [];
    const observability = createLunaObservability({
      run: { id: "run-1" },
      workflow: { id: "code-review" },
      sinks: [
        {
          id: "memory",
          required: true,
          append: (event) => {
            events.push(event);
          }
        }
      ]
    });

    const result = await runWorkflowSchedule({
      nodes: [builtInNode("a"), builtInNode("b", ["a"])],
      state: baseState(),
      execution: { max_concurrency: 1 },
      observability,
      runNode: async ({ node }) => {
        if (node.id === "a") {
          throw cause;
        }

        return { id: node.id };
      },
      writePlannedArtifacts,
      builtInMetadata: () => ({})
    });

    expect(result.status).toBe("failed");
    expect(result.steps.a).toMatchObject({
      status: "failed",
      code: "scheduler_step_failed",
      details: { cause_code: "node_exploded", step_id: "a" }
    });
    expect(result.steps.b).toEqual({
      status: "skipped",
      code: "scheduler_dependency_failed",
      step_id: "b"
    });
    expect(writePlannedArtifacts).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "luna.scheduler.step.failed",
        step_id: "b",
        status: "skipped",
        error: expect.objectContaining({
          code: "scheduler_dependency_failed"
        })
      })
    );
  });

  it("does not return captured workspace when workspace artifact write fails", async () => {
    const artifactFailure = new Error("artifact failed") as Error & {
      code: string;
    };
    artifactFailure.code = "artifact_write_failed";
    const workspace = {
      run_id: "run-1",
      path: "/workspace",
      preserved: true,
      reason: "failure"
    };

    const result = await runWorkflowSchedule({
      nodes: [builtInNode("workspace")],
      state: baseState(),
      execution: { max_concurrency: 1 },
      runNode: async () => workspace,
      writePlannedArtifacts: async () => {
        throw artifactFailure;
      },
      builtInMetadata: () => ({ capturesWorkspace: true })
    });

    expect(result).toMatchObject({
      status: "failed",
      steps: {
        workspace: {
          code: "scheduler_step_failed",
          details: {
            step_id: "workspace",
            cause_code: "artifact_write_failed"
          }
        }
      }
    });
    expect(result.workspace).toBeUndefined();
  });

  it("deep-freezes node state snapshots in non-production tests", async () => {
    const result = await runWorkflowSchedule({
      nodes: [builtInNode("a")],
      state: baseState(),
      execution: { max_concurrency: 1 },
      runNode: async ({ state }) => {
        (state.steps as Record<string, unknown>).mutated = true;
        return { status: "unreachable" };
      },
      writePlannedArtifacts: vi.fn(async () => undefined),
      builtInMetadata: () => ({})
    });

    expect(result.status).toBe("failed");
    expect(result.steps.a).toMatchObject({
      status: "failed",
      code: "scheduler_step_failed",
      details: { step_id: "a" }
    });
  });

  it("preserves original cause code in schedulerStepFailed details", () => {
    const cause = new Error("missing reference") as Error & { code: string };
    cause.code = "workflow_reference_missing";

    expect(schedulerStepFailed("repo_context", cause)).toMatchObject({
      status: "failed",
      code: "scheduler_step_failed",
      details: {
        step_id: "repo_context",
        cause_code: "workflow_reference_missing"
      }
    });
  });
});
