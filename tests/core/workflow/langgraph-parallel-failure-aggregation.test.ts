import { describe, expect, it } from "vitest";
import { failNode, startNodeAttempt } from "../../../src/core/runtime/lifecycle.js";
import {
  createInitialRuntimeState,
  type LunaRuntimeState
} from "../../../src/core/runtime/state.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import { runCompiledWorkflow } from "../../../src/runtime/langgraph/workflow-runner.js";
import {
  nodeAttemptFailures,
  WorkflowNodeAttemptFailure
} from "../../../src/runtime/workflow/failure-state.js";
import {
  runnerAgentRuntime,
  runnerBackends,
  runnerRegistry,
  runnerWorkflow
} from "./runner-test-support.js";

function failedAttempt(nodeId: string): WorkflowNodeAttemptFailure {
  const state = createInitialRuntimeState({
    invocation: {},
    config: {},
    run: {
      run_id: "aggregate-order",
      workflow_id: "runner-test",
      attempt: 1,
      started_at: "2026-07-11T00:00:00.000Z"
    },
    workflow: { id: "runner-test", mode: "read_only" }
  });
  return new WorkflowNodeAttemptFailure(
    new Error(`${nodeId} failed`),
    failNode(startNodeAttempt(state, nodeId, 1), nodeId)
  );
}

describe("LangGraph concurrent failure aggregation", () => {
  it("traverses error causes and cyclic aggregates in stable node-id order", () => {
    const alpha = failedAttempt("alpha");
    const beta = failedAttempt("beta");
    const cyclic = new AggregateError([], "cyclic");
    cyclic.errors.push(
      cyclic,
      beta,
      new Error("alpha wrapper", { cause: alpha })
    );
    const nested = new Error("outer", { cause: cyclic });

    expect(nodeAttemptFailures(nested).map(
      (failure) => failure.state.primary_failure?.node_id
    )).toEqual(["alpha", "beta"]);
  });

  it("preserves two failed roots and a completed sibling in terminal state", async () => {
    const definition: WorkflowDefinition = {
      ...runnerWorkflow([
        {
          id: "beta_partial",
          type: "built_in",
          uses: "runtime.ok",
          artifacts: [
            {
              path: "beta-first.json",
              publisher: "artifacts.manifest_publisher",
              source: { expression: "$.steps.beta_partial" },
              format: "json",
              required: true
            },
            {
              path: "beta-second.json",
              publisher: "artifacts.manifest_publisher",
              source: { expression: "$.steps.beta_partial" },
              format: "json",
              required: true
            }
          ]
        },
        { id: "completed", type: "built_in", uses: "runtime.ok" },
        { id: "alpha_failure", type: "built_in", uses: "runtime.ok" }
      ]),
      execution: { max_concurrency: 3 }
    };
    const compiled = compileWorkflow({
      workflow: definition,
      registry: runnerRegistry
    });
    const backends = runnerBackends();
    const alphaFailure = new Error("alpha root failed");
    const betaFailure = new Error("beta artifact batch failed");
    let releaseAllStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      releaseAllStarted = resolve;
    });
    let started = 0;
    const arrive = async (): Promise<void> => {
      started += 1;
      if (started === 3) {
        releaseAllStarted();
      }
      await allStarted;
    };
    let releaseBetaFailure!: () => void;
    const betaReachedFailure = new Promise<void>((resolve) => {
      releaseBetaFailure = resolve;
    });
    let observedFailure: LunaRuntimeState | undefined;

    await expect(runCompiledWorkflow({
      compiled,
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-multiple-parallel-failures",
        workflow_id: definition.id,
        attempt: 1,
        started_at: "2026-07-11T00:00:00.000Z"
      },
      backends,
      builtIns: {
        "runtime.ok": async ({ node }) => {
          await arrive();
          if (node.id === "alpha_failure") {
            await betaReachedFailure;
            throw alphaFailure;
          }
          return { ok: true };
        }
      },
      artifactPublisher: {
        async publish({ node_id, path }) {
          if (path === "beta-second.json") {
            releaseBetaFailure();
            throw betaFailure;
          }
          return { id: path, uri: `memory://${path}`, node_id };
        }
      },
      agentRuntime: runnerAgentRuntime({}),
      onFailedState(state) {
        observedFailure = state;
      }
    })).rejects.toBe(alphaFailure);

    expect(observedFailure).toMatchObject({
      run_status: "failed",
      primary_failure: { node_id: "alpha_failure", status: "failed" },
      node_statuses: {
        alpha_failure: { status: "failed", attempt: 1 },
        beta_partial: { status: "failed", attempt: 1 },
        completed: { status: "succeeded", attempt: 1 }
      },
      attempts: {
        alpha_failure: {
          count: 1,
          history: [{ attempt: 1, status: "failed" }]
        },
        beta_partial: {
          count: 1,
          history: [{ attempt: 1, status: "failed" }]
        },
        completed: {
          count: 1,
          history: [{ attempt: 1, status: "succeeded" }]
        }
      },
      steps: {
        beta_partial: { ok: true },
        completed: { ok: true }
      },
      artifact_refs: [
        {
          id: "beta-first.json",
          uri: "memory://beta-first.json",
          node_id: "beta_partial"
        }
      ]
    });
    const terminal = await backends.checkpoints.load(
      "run-multiple-parallel-failures",
      {
        checkpointId: "terminal-run-multiple-parallel-failures-failed",
        checkpointNs: ""
      }
    );
    expect(terminal).toMatchObject({
      state: {
        run_status: "failed",
        artifact_refs: [
          {
            id: "beta-first.json",
            uri: "memory://beta-first.json",
            node_id: "beta_partial"
          }
        ]
      },
      metadata: { source: "terminal", run_status: "failed" }
    });
  });
});
