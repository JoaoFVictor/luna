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
  instructions: "Review the workflow output.",
  model_profile: { model: "openai/gpt-5", reasoning_effort: "medium" },
  tools: { tools: [], runtime_requirements: [] },
  context: { repository: "luna" },
  cwd: "/tmp/runner-test"
};

const okOutputSchema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };

describe("workflow runner", () => {
  it("executes built-in nodes and validates final workflow output before success", async () => {
    const definition = workflow(
      [{ id: "ok", type: "built_in", uses: "runtime.ok" }],
      {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" } }
      }
    );
    const builtIns: Record<string, WorkflowBuiltInExecutor> = {
      "runtime.ok": vi.fn(async () => ({ ok: true }))
    };

    const result = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-1",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: backends(),
      builtIns,
      agentRuntime: agentRuntime({})
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("expected workflow to succeed");
    }
    expect(result.output).toEqual({ ok: true });
  });

  it("executes agent nodes through AgentRuntimePort", async () => {
    const runtime = agentRuntime({ reviewed: true });
    const definition = workflow([
      {
        id: "review",
        type: "agent",
        agent: "reviewer",
        output_schema: "agents.output"
      }
    ]);

    const result = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-2",
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
          tools: { tools: [], runtime_requirements: ["mcp_tools"] }
        }
      }
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("expected workflow to succeed");
    }
    expect(runtime.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        node_id: "review",
        agent_id: "reviewer",
        instructions: "Review the workflow output.",
        model_profile: { model: "openai/gpt-5", reasoning_effort: "medium" },
        tools: { tools: [], runtime_requirements: ["mcp_tools"] },
        context: { repository: "luna" },
        cwd: "/tmp/runner-test",
        runtime_requirements: ["mcp_tools"]
      })
    );
    expect(runtime.validate).toHaveBeenCalledWith(
      expect.objectContaining({ node_id: "review", agent_id: "reviewer" })
    );
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
          instructions: "Review the implementation.",
          model_profile: { model: "openai/gpt-5", reasoning_effort: "high" },
          context: { role: "reviewer" }
        },
        acceptance: {
          ...agentDefaults,
          instructions: "Check acceptance criteria.",
          model_profile: { model: "openai/gpt-5-mini", reasoning_effort: "low" },
          context: { role: "acceptance" }
        }
      }
    });

    expect(runtime.runAgent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        node_id: "review",
        agent_id: "change-reviewer",
        instructions: "Review the implementation.",
        model_profile: { model: "openai/gpt-5", reasoning_effort: "high" },
        context: { role: "reviewer" }
      })
    );
    expect(runtime.runAgent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        node_id: "acceptance",
        agent_id: "change-acceptance-reviewer",
        instructions: "Check acceptance criteria.",
        model_profile: { model: "openai/gpt-5-mini", reasoning_effort: "low" },
        context: { role: "acceptance" }
      })
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
    await expect(stores.events.list("run-unsupported")).resolves.toEqual([]);
  });

  it("rejects unsupported tool runtime requirements from projected agent input before starting", async () => {
    const runtime = agentRuntime({ reviewed: true });
    const stores = backends();
    const definition = workflow([
      {
        id: "review",
        type: "agent",
        agent: "reviewer",
        output_schema: "agents.output"
      }
    ]);

    await expect(
      runCompiledWorkflow({
        compiled: compileWorkflow({ workflow: definition, registry }),
        workflow: definition,
        invocation: {},
        config: {},
        run: {
          run_id: "run-tool-requirements",
          workflow_id: "runner-test",
          attempt: 1,
          started_at: "2026-06-25T00:00:00.000Z"
        },
        backends: stores,
        builtIns: {},
        agentRuntime: {
          ...runtime,
          describe: () => ({
            id: "limited",
            display_name: "Limited",
            supported_tool_protocols: ["local"],
            supported_runtime_requirements: ["tool_calling"]
          })
        },
        agentInputs: {
          review: {
            ...agentDefaults,
            tools: { tools: [], runtime_requirements: ["mcp_tools"] }
          }
        }
      })
    ).rejects.toMatchObject({ code: "runtime_state_invalid" });
    expect(runtime.validate).not.toHaveBeenCalled();
    expect(runtime.runAgent).not.toHaveBeenCalled();
    await expect(stores.events.list("run-tool-requirements")).resolves.toEqual([]);
  });

  it("rejects mismatched compiled workflow metadata before starting", async () => {
    const stores = backends();
    const definition = workflow([{ id: "ok", type: "built_in", uses: "runtime.ok" }]);
    const compiled = {
      ...compileWorkflow({ workflow: definition, registry }),
      workflow_id: "other-workflow"
    };

    await expect(
      runCompiledWorkflow({
        compiled,
        workflow: definition,
        invocation: {},
        config: {},
        run: {
          run_id: "run-mismatched-compiled",
          workflow_id: "runner-test",
          attempt: 1,
          started_at: "2026-06-25T00:00:00.000Z"
        },
        backends: stores,
        builtIns: { "runtime.ok": async () => ({ ok: true }) },
        agentRuntime: agentRuntime({})
      })
    ).rejects.toMatchObject({ code: "runtime_state_invalid" });
    await expect(stores.events.list("run-mismatched-compiled")).resolves.toEqual([]);
  });

  it("runs independent non-linear branches", async () => {
    const stores = backends();
    const definition = workflow([
      { id: "left", type: "built_in", uses: "runtime.ok" },
      { id: "right", type: "built_in", uses: "runtime.ok" }
    ]);

    const result = await runCompiledWorkflow({
        compiled: compileWorkflow({ workflow: definition, registry }),
        workflow: definition,
        invocation: {},
        config: {},
        run: {
          run_id: "run-nonlinear",
          workflow_id: "runner-test",
          attempt: 1,
          started_at: "2026-06-25T00:00:00.000Z"
        },
        backends: stores,
        builtIns: { "runtime.ok": async () => ({ ok: true }) },
        agentRuntime: agentRuntime({})
      });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("expected workflow to succeed");
    }
    expect(result.output).toEqual({
      left: { ok: true },
      right: { ok: true }
    });
    expect(result.state.steps).toEqual({
      left: { ok: true },
      right: { ok: true }
    });
  });

  it("supports max_concurrency above one", async () => {
    const stores = backends();
    const definition = {
      ...workflow([{ id: "ok", type: "built_in", uses: "runtime.ok" }]),
      execution: { max_concurrency: 2 }
    };

    await expect(
      runCompiledWorkflow({
        compiled: compileWorkflow({ workflow: definition, registry }),
        workflow: definition,
        invocation: {},
        config: {},
        run: {
          run_id: "run-max-concurrency",
          workflow_id: "runner-test",
          attempt: 1,
          started_at: "2026-06-25T00:00:00.000Z"
        },
        backends: stores,
        builtIns: { "runtime.ok": async () => ({ ok: true }) },
        agentRuntime: agentRuntime({})
      })
    ).resolves.toMatchObject({ status: "succeeded" });
  });

  it("rejects invalid node output before publishing to steps or checkpoint", async () => {
    const stores = backends();
    const definition = workflow([
      { id: "bad", type: "built_in", uses: "runtime.ok" }
    ]);

    await expect(
      runCompiledWorkflow({
        compiled: compileWorkflow({ workflow: definition, registry }),
        workflow: definition,
        invocation: {},
        config: {},
        run: {
          run_id: "run-3",
          workflow_id: "runner-test",
          attempt: 1,
          started_at: "2026-06-25T00:00:00.000Z"
        },
        backends: stores,
        builtIns: { "runtime.ok": async () => ({ ok: "yes" }) },
        agentRuntime: agentRuntime({})
      })
    ).rejects.toMatchObject({ code: "runtime_node_output_schema_invalid" });
    await expect(stores.checkpoints.load("run-3")).resolves.toBeUndefined();
  });

  it("resolves runtime expressions before executing built-ins", async () => {
    const executor = vi.fn(async ({ input }) => ({ ok: input.value === "hello" }));
    const definition = workflow([
      {
        id: "ok",
        type: "built_in",
        uses: "runtime.ok",
        input: { value: { expression: "$.invocation.title" } }
      }
    ]);

    await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: { title: "hello" },
      config: {},
      run: {
        run_id: "run-expression",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: backends(),
      builtIns: { "runtime.ok": executor },
      agentRuntime: agentRuntime({})
    });

    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({ input: { value: "hello" } })
    );
  });

  it("reports runtime expression errors with YAML path and capability context", async () => {
    const definition = workflow([
      {
        id: "ok",
        type: "built_in",
        uses: "runtime.ok",
        input: { value: { expression: "$.steps.missing.value" } }
      }
    ]);

    await expect(
      runCompiledWorkflow({
        compiled: compileWorkflow({ workflow: definition, registry }),
        workflow: definition,
        invocation: {},
        config: {},
        run: {
          run_id: "run-expression-failure",
          workflow_id: "runner-test",
          attempt: 1,
          started_at: "2026-06-25T00:00:00.000Z"
        },
        backends: backends(),
        builtIns: { "runtime.ok": async () => ({ ok: true }) },
        agentRuntime: agentRuntime({})
      })
    ).rejects.toMatchObject({
      code: "workflow_expression_unresolved",
      path: "$.nodes[0].input.value",
      capability: "runtime.ok"
    });
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

    const result = await withTimeout(
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

    expect(result.status).toBe("succeeded");
    expect(joinInput).toEqual({ left: true, right: true });
    expect(builtIns["runtime.ok"]).toHaveBeenCalledTimes(3);
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
    const siblingWrites = stores.checkpoints.listWrites(
      "run-parallel-failure",
      "",
      "node-output-run-parallel-failure-sibling"
    );
    await expect(siblingWrites).resolves.toEqual([
      expect.objectContaining({
        task_id: "sibling",
        channel: "steps",
        value: { ok: true }
      })
    ]);
    await expect(stores.events.list("run-parallel-failure")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "node.succeeded", node_id: "sibling" })
      ])
    );
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

    const result = await runCompiledWorkflow({
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

    expect(result.status).toBe("succeeded");
    expect(maxActive).toBe(1);
    expect(acquireCalls).toEqual(
      Array(2).fill("repository:repo-1:exclusive")
    );
  });

  it("runs deferred final report nodes after the main workflow graph", async () => {
    const definition = {
      ...workflow(
        [
          {
            id: "final_report",
            type: "built_in",
            uses: "runtime.ok",
            input: { main: { expression: "$.steps.main.ok" } }
          },
          { id: "main", type: "built_in", uses: "runtime.ok" }
        ],
        okOutputSchema
      ),
      execution: { max_concurrency: 2 }
    };
    const calls: Array<{ node: string; input: unknown }> = [];

    const result = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-deferred-final-report",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: backends(),
      builtIns: {
        "runtime.ok": async ({ node, input }) => {
          calls.push({ node: node.id, input });
          return { ok: true };
        }
      },
      builtInMetadata: (node) => node.id === "final_report"
        ? { deferredLifecycle: "final_report" }
        : {},
      agentRuntime: agentRuntime({})
    });

    expect(result.status).toBe("succeeded");
    expect(calls).toEqual([
      { node: "main", input: {} },
      { node: "final_report", input: { main: true } }
    ]);
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
    expect(result.state).not.toHaveProperty("repository");
    expect(result.state).not.toHaveProperty("workspace");
    expect(result.state).not.toHaveProperty("workspaceRoot");
    expect(result.state).not.toHaveProperty("agentsRoot");
  });

  it("rejects conflicting duplicate workspace capture", async () => {
    const definition = workflow([
      { id: "first", type: "built_in", uses: "runtime.workspace" },
      {
        id: "second",
        type: "built_in",
        uses: "runtime.workspace",
        after: ["first"]
      }
    ]);

    await expect(
      runCompiledWorkflow({
        compiled: compileWorkflow({ workflow: definition, registry }),
        workflow: definition,
        invocation: {},
        config: {},
        run: {
          run_id: "run-workspace-conflict",
          workflow_id: "runner-test",
          attempt: 1,
          started_at: "2026-06-25T00:00:00.000Z"
        },
        backends: backends(),
        builtIns: {
          "runtime.workspace": ({ node }) => ({
            run_id: "run-workspace-conflict",
            path: `/tmp/${node.id}`,
            preserved: false,
            reason: "active"
          })
        },
        builtInMetadata: (node) =>
          node.capability_id === "runtime.workspace"
            ? { capturesWorkspace: true }
            : {},
        agentRuntime: agentRuntime({})
      })
    ).rejects.toMatchObject({ code: "runtime_state_invalid" });
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
