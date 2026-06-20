import { describe, expect, it, vi } from "vitest";
import {
  runWorkflowSchedule,
  schedulerStepFailed
} from "../../src/core/workflow-scheduler.js";
import { noopRunLogger } from "../../src/core/run-logger.js";
import type { WorkflowNode } from "../../src/core/workflow-definition.js";
import type { SchedulerWorkflowState } from "../../src/core/workflow-state.js";

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

function builtInNode(id: string, after?: string[]): WorkflowNode {
  return {
    id,
    type: "built_in",
    uses: "preflight",
    ...(after === undefined ? {} : { after })
  };
}

describe("workflow scheduler", () => {
  it("runs ready nodes sequentially when max_concurrency is 1", async () => {
    const callOrder: string[] = [];
    const nodes = [builtInNode("a"), builtInNode("b", ["a"])];

    const result = await runWorkflowSchedule({
      nodes,
      state: baseState(),
      execution: { max_concurrency: 1 },
      logger: noopRunLogger,
      runNode: async ({ node }) => {
        callOrder.push(node.id);
        return { id: node.id };
      },
      writeNodeArtifact: vi.fn(async () => undefined),
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

  it("keeps sequential execution even when max_concurrency is greater than 1", async () => {
    const running: string[] = [];
    const completed: string[] = [];

    const result = await runWorkflowSchedule({
      nodes: [builtInNode("a"), builtInNode("b")],
      state: baseState(),
      execution: { max_concurrency: 2 },
      logger: noopRunLogger,
      runNode: async ({ node }) => {
        expect(running).toHaveLength(0);
        running.push(node.id);
        await Promise.resolve();
        completed.push(node.id);
        running.pop();
        return { id: node.id };
      },
      writeNodeArtifact: vi.fn(async () => undefined),
      builtInMetadata: () => ({})
    });

    expect(result.status).toBe("success");
    expect(completed).toEqual(["a", "b"]);
  });

  it("wraps node failures as scheduler step failures and skips dependents", async () => {
    const cause = new Error("node exploded") as Error & { code: string };
    cause.code = "node_exploded";
    const writeNodeArtifact = vi.fn(async () => undefined);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const result = await runWorkflowSchedule({
      nodes: [builtInNode("a"), builtInNode("b", ["a"])],
      state: baseState(),
      execution: { max_concurrency: 1 },
      logger,
      runNode: async ({ node }) => {
        if (node.id === "a") {
          throw cause;
        }

        return { id: node.id };
      },
      writeNodeArtifact,
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
    expect(writeNodeArtifact).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "luna.scheduler.step_failed",
      expect.objectContaining({
        "luna.step_id": "b",
        "error.code": "scheduler_dependency_failed"
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
      logger: noopRunLogger,
      runNode: async () => workspace,
      writeNodeArtifact: async () => {
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
      logger: noopRunLogger,
      runNode: async ({ state }) => {
        (state.steps as Record<string, unknown>).mutated = true;
        return { status: "unreachable" };
      },
      writeNodeArtifact: vi.fn(async () => undefined),
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
