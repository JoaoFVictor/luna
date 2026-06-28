import { describe, expect, it, vi } from "vitest";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import type { WorkflowDefinition, WorkflowNode } from "../../../src/core/workflow/definition-types.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import {
  runCompiledWorkflow,
  type WorkflowAgentDefaults,
  type WorkflowBuiltInExecutor
} from "../../../src/runtime/langgraph/workflow-runner.js";
import type { WorkflowLockManager } from "../../../src/core/workflow/runner-locks.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "runtime",
    kind: "execution",
    version: "1.0.0",
    built_ins: {
      "runtime.ok": {
        id: "runtime.ok",
        input_schema: { type: "object" },
        output_schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean" } }
        },
        required_ports: []
      },
      "runtime.workspace": {
        id: "runtime.workspace",
        input_schema: { type: "object" },
        output_schema: {
          type: "object",
          additionalProperties: false,
          required: ["run_id", "path", "preserved", "reason"],
          properties: {
            run_id: { type: "string" },
            path: { type: "string" },
            preserved: { type: "boolean" },
            reason: { type: "string" }
          }
        },
        required_ports: []
      }
    }
  }),
  capabilityManifest({
    id: "agents",
    kind: "execution",
    version: "1.0.0",
    schemas: {
      "agents.output": {
        id: "agents.output",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["reviewed"],
          properties: { reviewed: { type: "boolean" } }
        }
      }
    }
  })
]);

function workflow(nodes: WorkflowNode[], outputSchema: unknown = { type: "object" }): WorkflowDefinition {
  return {
    id: "runner-test",
    type: "workflow",
    mode: "read_only",
    directory: "/tmp/runner-test",
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    input_schema_content: { type: "object" },
    output_schema_content: outputSchema,
    capabilities: ["runtime", "agents"],
    graph: { nodes },
    revision: "revision-1",
    external_definition_digests: {},
    execution: { max_concurrency: 1 },
    requires: { repository: false },
    observability: { exporters: { runtime_log: { enabled: true, required: false } } },
    subagent_policy: { allow_write: false }
  };
}

function backends() {
  return {
    artifacts: createMemoryArtifactManifestStore(),
    events: createMemoryEventStore(),
    interrupts: createMemoryInterruptStore(),
    checkpoints: createMemoryCheckpointStore(),
    runtimeLogs: createMemoryRuntimeLogStore()
  };
}

function agentRuntime(output: unknown): AgentRuntimePort {
  return {
    describe: () => ({
      id: "test-agent-runtime",
      display_name: "Test",
      supported_tool_protocols: ["local"],
      supported_runtime_requirements: ["tool_calling", "mcp_tools"]
    }),
    validate: vi.fn(),
    runAgent: vi.fn(async () => ({ output }))
  };
}

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

const agentDefaults: WorkflowAgentDefaults = {
  agent: {
    id: "reviewer",
    mode: "read_only",
    instructions: "Review the workflow output."
  },
  model_profile: { model: "openai/gpt-5", reasoning_effort: "medium" },
  tools: { tools: [], runtime_requirements: [] },
  cwd: "/tmp/runner-test"
};

const okOutputSchema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };

describe("workflow runner", () => {
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
        { id: "sibling", type: "built_in", uses: "runtime.ok" }
      ]),
      execution: { max_concurrency: 2 }
    };
    let releaseSibling!: () => void;
    const siblingFinished = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    let siblingCompleted = false;

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
              throw new Error("branch failed");
            }

            siblingCompleted = true;
            releaseSibling();
            return { ok: true };
          }
        },
        agentRuntime: agentRuntime({})
      })
    ).rejects.toThrow("branch failed");

    expect(siblingCompleted).toBe(true);
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

  it("applies workspace lifecycle completion before final output", async () => {
    const definition = workflow(
      [
        {
          id: "capture",
          type: "built_in",
          uses: "runtime.workspace"
        }
      ],
      {
        type: "object",
        additionalProperties: false,
        required: ["run_id", "path", "preserved", "reason"],
        properties: {
          run_id: { type: "string" },
          path: { type: "string" },
          preserved: { type: "boolean" },
          reason: { type: "string" }
        }
      }
    );

    const result = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-workspace-cleanup",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      runtimeContext: {
        repository: { id: "repo-1" },
        workspaceRoot: "/tmp/workspaces"
      },
      backends: backends(),
      builtIns: {
        "runtime.workspace": () => ({
          run_id: "run-workspace-cleanup",
          path: "/tmp/workspaces/repo-1/run-workspace-cleanup",
          preserved: true,
          reason: "created"
        })
      },
      builtInMetadata: (node) =>
        node.capability_id === "runtime.workspace"
          ? { capturesWorkspace: true }
          : {},
      workspaceLifecycle: {
        complete: vi.fn(async ({ status, runtimeContext }) => ({
          ...(runtimeContext.workspace as object),
          preserved: false,
          reason: `${status}_cleanup`
        }))
      },
      agentRuntime: agentRuntime({})
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("expected workflow to succeed");
    }
    expect(result.output).toMatchObject({
      preserved: false,
      reason: "succeeded_cleanup"
    });
    expect(result.state.steps.capture).toMatchObject({
      preserved: false,
      reason: "succeeded_cleanup"
    });
  });

  it("rejects final workflow output before marking the run succeeded", async () => {
    const stores = backends();
    const definition = workflow(
      [{ id: "ok", type: "built_in", uses: "runtime.ok" }],
      {
        type: "object",
        additionalProperties: false,
        required: ["final"],
        properties: { final: { type: "boolean" } }
      }
    );

    await expect(
      runCompiledWorkflow({
        compiled: compileWorkflow({ workflow: definition, registry }),
        workflow: definition,
        invocation: {},
        config: {},
        run: {
          run_id: "run-final-invalid",
          workflow_id: "runner-test",
          attempt: 1,
          started_at: "2026-06-25T00:00:00.000Z"
        },
        backends: stores,
        builtIns: { "runtime.ok": async () => ({ ok: true }) },
        agentRuntime: agentRuntime({})
      })
    ).rejects.toMatchObject({ code: "runtime_node_output_schema_invalid" });
    expect((await stores.events.list("run-final-invalid")).map((event) => event.type)).not.toContain(
      "run.succeeded"
    );
  });
});
