import { describe, expect, it, vi } from "vitest";
import type { LunaRuntimeState } from "../../../src/core/runtime/state.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import {
  runCompiledWorkflow,
  type WorkflowBuiltInExecutor
} from "../../../src/runtime/langgraph/workflow-runner.js";
import type { WorkflowLockManager } from "../../../src/core/workflow/runner-locks.js";
import {
  runnerAgentDefaults as agentDefaults,
  runnerAgentRuntime as agentRuntime,
  runnerBackends as backends,
  runnerRegistry as registry,
  runnerWorkflow as workflow
} from "./runner-test-support.js";

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

describe("workflow runner execution", () => {
  it("passes the run cancellation signal to built-in executors", async () => {
    const controller = new AbortController();
    const definition = workflow([
      { id: "ok", type: "built_in", uses: "runtime.ok" }
    ]);
    let receivedSignal: AbortSignal | undefined;

    await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-built-in-signal",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      signal: controller.signal,
      backends: backends(),
      builtIns: {
        "runtime.ok": async ({ signal }) => {
          receivedSignal = signal;
          return { ok: true };
        }
      },
      agentRuntime: agentRuntime({})
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  it("projects agent runtime input per node", async () => {
    const runtime = agentRuntime({ reviewed: true });
    const definition = workflow([
      {
        id: "review",
        type: "agent",
        agent: "change-reviewer",
        output_schema: "agents.output"
      },
      {
        id: "acceptance",
        type: "agent",
        agent: "change-acceptance-reviewer",
        output_schema: "agents.output",
        after: ["review"]
      }
    ]);

    await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-agent-inputs",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: backends(),
      builtIns: {},
      agentRuntime: runtime,
      agentInputs: {
        review: {
          ...agentDefaults,
          agent: {
            id: "change-reviewer",
            mode: "read_only",
            instructions: "Review the implementation."
          },
          model_profile: { model: "openai/gpt-5", reasoning_effort: "high" }
        },
        acceptance: {
          ...agentDefaults,
          agent: {
            id: "change-acceptance-reviewer",
            mode: "read_only",
            instructions: "Check acceptance criteria."
          },
          model_profile: { model: "openai/gpt-5-mini", reasoning_effort: "low" }
        }
      }
    });

    expect(runtime.runAgent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        node_id: "review",
        agent_id: "change-reviewer",
        model_profile: { model: "openai/gpt-5", reasoning_effort: "high" }
      })
    );
    expect(vi.mocked(runtime.runAgent).mock.calls[0]?.[0].instructions).toContain(
      "Review the implementation."
    );
    expect(runtime.runAgent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        node_id: "acceptance",
        agent_id: "change-acceptance-reviewer",
        model_profile: { model: "openai/gpt-5-mini", reasoning_effort: "low" }
      })
    );
    expect(vi.mocked(runtime.runAgent).mock.calls[1]?.[0].instructions).toContain(
      "Check acceptance criteria."
    );
  });

  it("rejects unsupported agent runtime requirements before executing the agent", async () => {
    const runtime = agentRuntime({ reviewed: true });
    const stores = backends();
    const preflight = vi.fn(async () => ({ ok: true }));
    const definition = workflow([
      { id: "ok", type: "built_in", uses: "runtime.ok" },
      {
        id: "review",
        type: "agent",
        agent: "reviewer",
        output_schema: "agents.output",
        runtime_requirements: ["mcp_tools"],
        after: ["ok"]
      }
    ]);

    await expect(
      runCompiledWorkflow({
        compiled: compileWorkflow({ workflow: definition, registry }),
        workflow: definition,
        invocation: {},
        config: {},
        run: {
          run_id: "run-unsupported",
          workflow_id: "runner-test",
          attempt: 1,
          started_at: "2026-06-25T00:00:00.000Z"
        },
        backends: stores,
        builtIns: { "runtime.ok": preflight },
        agentRuntime: {
          ...runtime,
          describe: () => ({
            id: "limited",
            display_name: "Limited",
            supported_tool_protocols: ["local"],
            supported_runtime_requirements: ["tool_calling"]
          })
        }
      })
    ).rejects.toMatchObject({ code: "runtime_state_invalid" });
    expect(preflight).not.toHaveBeenCalled();
    expect(runtime.runAgent).not.toHaveBeenCalled();
  });

  it("runs independent DAG branches up to max_concurrency and joins their outputs", async () => {
    const definition = {
      ...workflow(
        [
          { id: "left", type: "built_in", uses: "runtime.ok" },
          { id: "right", type: "built_in", uses: "runtime.ok" },
          {
            id: "join",
            type: "built_in",
            uses: "runtime.ok",
            after: ["left", "right"],
            input: {
              left: { expression: "$.steps.left.ok" },
              right: { expression: "$.steps.right.ok" }
            }
          }
        ],
        {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean" } }
        }
      ),
      execution: { max_concurrency: 2 }
    };
    let releaseLeft!: () => void;
    const leftMayFinish = new Promise<void>((resolve) => {
      releaseLeft = resolve;
    });
    let joinInput: unknown;
    const builtIns: Record<string, WorkflowBuiltInExecutor> = {
      "runtime.ok": vi.fn(async ({ node, input }) => {
        if (node.id === "left") {
          await leftMayFinish;
        }
        if (node.id === "join") {
          joinInput = input;
        }

        return { ok: true };
      })
    };

    setTimeout(releaseLeft, 20);

    await withTimeout(
      runCompiledWorkflow({
        compiled: compileWorkflow({
          workflow: definition,
          registry,
          reducers: { steps: "object_merge" }
        }),
        workflow: definition,
        invocation: {},
        config: {},
        run: {
          run_id: "run-parallel-branches",
          workflow_id: "runner-test",
          attempt: 1,
          started_at: "2026-06-25T00:00:00.000Z"
        },
        backends: backends(),
        builtIns,
        agentRuntime: agentRuntime({})
      }),
      500,
      "parallel workflow branches did not run concurrently"
    );

    expect(joinInput).toEqual({ left: true, right: true });
  });

  it("drains a parallel batch before surfacing a node failure", async () => {
    const stores = backends();
    const definition = {
      ...workflow([
        { id: "fail", type: "built_in", uses: "runtime.ok" },
        {
          id: "sibling",
          type: "built_in",
          uses: "runtime.ok",
          artifacts: [
            {
              path: "sibling.json",
              publisher: "artifacts.manifest_publisher",
              source: { expression: "$.steps.sibling" },
              format: "json",
              required: true
            }
          ]
        }
      ]),
      execution: { max_concurrency: 2 }
    };
    let releaseSibling!: () => void;
    const siblingFinished = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    let siblingCompleted = false;
    const runtimeFailure = new Error("branch failed");
    let observedFailure: LunaRuntimeState | undefined;

    await expect(
      runCompiledWorkflow({
        compiled: compileWorkflow({ workflow: definition, registry }),
        workflow: definition,
        invocation: {},
        config: {},
        run: {
          run_id: "run-parallel-failure",
          workflow_id: "runner-test",
          attempt: 1,
          started_at: "2026-06-25T00:00:00.000Z"
        },
        backends: stores,
        builtIns: {
          "runtime.ok": async ({ node }) => {
            if (node.id === "fail") {
              await siblingFinished;
              throw runtimeFailure;
            }

            siblingCompleted = true;
            releaseSibling();
            return { ok: true };
          }
        },
        artifactPublisher: {
          async publish({ node_id, path }) {
            return {
              id: path,
              uri: `memory://${path}`,
              node_id
            };
          }
        },
        agentRuntime: agentRuntime({}),
        onFailedState: (state) => {
          observedFailure = state;
        }
      })
    ).rejects.toBe(runtimeFailure);

    expect(siblingCompleted).toBe(true);
    expect(observedFailure).toMatchObject({
      run_status: "failed",
      primary_failure: { node_id: "fail", status: "failed" },
      node_statuses: {
        fail: { status: "failed", attempt: 1 },
        sibling: { status: "succeeded", attempt: 1 }
      },
      attempts: {
        fail: {
          count: 1,
          history: [{ attempt: 1, status: "failed" }]
        },
        sibling: {
          count: 1,
          history: [{ attempt: 1, status: "succeeded" }]
        }
      },
      steps: { sibling: { ok: true } },
      artifact_refs: [
        {
          id: "sibling.json",
          uri: "memory://sibling.json",
          node_id: "sibling"
        }
      ]
    });
  });

  it("retains a committed artifact when the lease aborts after publication", async () => {
    const controller = new AbortController();
    const leaseFailure = new Error("lease lost after artifact commit");
    let observedFailure: LunaRuntimeState | undefined;
    const definition = workflow([
      {
        id: "publish",
        type: "built_in",
        uses: "runtime.ok",
        artifacts: [
          {
            path: "published.json",
            publisher: "artifacts.manifest_publisher",
            source: { expression: "$.steps.publish" },
            format: "json",
            required: true
          }
        ]
      }
    ]);

    await expect(runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-abort-after-artifact",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      signal: controller.signal,
      backends: backends(),
      builtIns: { "runtime.ok": async () => ({ ok: true }) },
      artifactPublisher: {
        async publish({ node_id, path }) {
          controller.abort(leaseFailure);
          return { id: path, uri: `memory://${path}`, node_id };
        }
      },
      agentRuntime: agentRuntime({}),
      onFailedState: (state) => {
        observedFailure = state;
      }
    })).rejects.toBe(leaseFailure);

    expect(observedFailure).toMatchObject({
      run_status: "failed",
      steps: { publish: { ok: true } },
      artifact_refs: [
        {
          id: "published.json",
          uri: "memory://published.json",
          node_id: "publish"
        }
      ]
    });
  });

  it("retains earlier artifacts when a later declared publication fails", async () => {
    const publishFailure = new Error("second artifact failed");
    let observedFailure: LunaRuntimeState | undefined;
    let publishCount = 0;
    const definition = workflow([
      {
        id: "publish",
        type: "built_in",
        uses: "runtime.ok",
        artifacts: [
          {
            path: "first.json",
            publisher: "artifacts.manifest_publisher",
            source: { expression: "$.steps.publish" },
            format: "json",
            required: true
          },
          {
            path: "second.json",
            publisher: "artifacts.manifest_publisher",
            source: { expression: "$.steps.publish" },
            format: "json",
            required: true
          }
        ]
      }
    ]);

    await expect(runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-partial-artifact-batch",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: backends(),
      builtIns: { "runtime.ok": async () => ({ ok: true }) },
      artifactPublisher: {
        async publish({ node_id, path }) {
          publishCount += 1;
          if (publishCount === 2) {
            throw publishFailure;
          }
          return { id: path, uri: `memory://${path}`, node_id };
        }
      },
      agentRuntime: agentRuntime({}),
      onFailedState: (state) => {
        observedFailure = state;
      }
    })).rejects.toBe(publishFailure);

    expect(observedFailure).toMatchObject({
      run_status: "failed",
      steps: { publish: { ok: true } },
      artifact_refs: [
        {
          id: "first.json",
          uri: "memory://first.json",
          node_id: "publish"
        }
      ]
    });
  });

  it("serializes workflow nodes that require the same repository lock", async () => {
    const definition = {
      ...workflow([
        { id: "left", type: "built_in", uses: "runtime.ok" },
        { id: "right", type: "built_in", uses: "runtime.ok" }
      ]),
      execution: { max_concurrency: 2 }
    };
    const acquireCalls: string[] = [];
    let active = 0;
    let maxActive = 0;
    let tail = Promise.resolve();
    const lockManager: WorkflowLockManager = {
      async acquire(resource, mode) {
        acquireCalls.push(`${resource}:${mode}`);
        const previous = tail;
        let releaseNext!: () => void;
        tail = new Promise<void>((resolve) => { releaseNext = resolve; });
        await previous;
        active += 1;
        maxActive = Math.max(maxActive, active);

        return async () => {
          active -= 1;
          releaseNext();
        };
      }
    };

    await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-repository-locks",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      runtimeContext: { repository: { id: "repo-1" } },
      backends: backends(),
      builtIns: { "runtime.ok": async () => ({ ok: true }) },
      builtInMetadata: () => ({
        locks: [{ resource: "repository", mode: "exclusive" }]
      }),
      lockManager,
      agentRuntime: agentRuntime({})
    });

    expect(maxActive).toBe(1);
    expect(acquireCalls).toHaveLength(2);
  });

  it("keeps operational context outside state while resolving repository and promoted workspace expressions", async () => {
    const definition = workflow(
      [
        {
          id: "capture",
          type: "built_in",
          uses: "runtime.workspace",
          input: { repo: { expression: "$.repository.name" } }
        },
        {
          id: "use_workspace",
          type: "built_in",
          uses: "runtime.ok",
          after: ["capture"],
          input: { cwd: { expression: "$.workspace.path" } }
        }
      ],
      {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" } }
      }
    );
    const seenInputs: unknown[] = [];

    const result = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-runtime-context",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      runtimeContext: {
        repository: { name: "luna" },
        workspaceRoot: "/tmp/workspaces",
        agentsRoot: "/tmp/agents"
      },
      backends: backends(),
      builtIns: {
        "runtime.workspace": ({ input, state, runtimeContext }) => {
          seenInputs.push({
            input,
            stateHasRepository: Object.prototype.hasOwnProperty.call(state, "repository"),
            workspaceRoot: runtimeContext.workspaceRoot
          });

          return {
            run_id: "run-runtime-context",
            path: "/tmp/workspaces/luna",
            preserved: false,
            reason: "active"
          };
        },
        "runtime.ok": ({ input, runtimeContext }) => {
          seenInputs.push({ input, workspace: runtimeContext.workspace });
          return { ok: true };
        }
      },
      builtInMetadata: (node) =>
        node.capability_id === "runtime.workspace"
          ? { capturesWorkspace: true }
          : {},
      agentRuntime: agentRuntime({})
    });

    expect(result.status).toBe("succeeded");
    expect(seenInputs).toEqual([
      {
        input: { repo: "luna" },
        stateHasRepository: false,
        workspaceRoot: "/tmp/workspaces"
      },
      {
        input: { cwd: "/tmp/workspaces/luna" },
        workspace: {
          run_id: "run-runtime-context",
          path: "/tmp/workspaces/luna",
          preserved: false,
          reason: "active"
        }
      }
    ]);
  });

  it("binds ordinary agent tools to the promoted workspace instead of the repository default", async () => {
    const runtime = agentRuntime({ reviewed: true });
    const definition = workflow([
      {
        id: "capture",
        type: "built_in",
        uses: "runtime.workspace"
      },
      {
        id: "review",
        type: "agent",
        agent: "change-reviewer",
        output_schema: "agents.output",
        after: ["capture"]
      }
    ]);

    await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-agent-workspace",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: backends(),
      builtIns: {
        "runtime.workspace": async () => ({
          run_id: "run-agent-workspace",
          path: "/tmp/worktrees/task-1",
          preserved: false,
          reason: "active"
        })
      },
      builtInMetadata: (node) =>
        node.capability_id === "runtime.workspace"
          ? { capturesWorkspace: true }
          : {},
      agentRuntime: runtime,
      agentInputs: {
        review: {
          ...agentDefaults,
          cwd: "/tmp/repositories/source",
          agent: {
            id: "change-reviewer",
            mode: "read_only",
            instructions: "Review the implementation."
          }
        }
      }
    });

    expect(runtime.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/worktrees/task-1" })
    );
  });
});
