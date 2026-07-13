import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import { RuntimeDurabilityRecoveryRequiredError } from "../../../src/core/runtime/errors.js";
import type { LunaRuntimeState } from "../../../src/core/runtime/state.js";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type { WorkflowDefinition, WorkflowNode } from "../../../src/core/workflow/definition-types.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import type { RunWorkflowInput } from "../../../src/core/workflow/execution-contracts.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";
import {
  createRuntimeLogProjectionSink
} from "../../../src/core/observability/sinks.js";
import { createWorkflowObservability } from "../../../src/core/observability/workflow-observability.js";
import {
  runCompiledWorkflowWithScheduler,
  type WorkflowNodeScheduler
} from "../../../src/runtime/workflow/runner-engine.js";
import { applyWorkflowGraphUpdate } from "../../../src/runtime/langgraph/workflow-state.js";
import { ensureWorkflowExecutionIdentity } from "../../../src/runtime/workflow/workflow-execution-identity.js";

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "runtime",
    kind: "execution",
    version: "1.0.0",
    built_ins: {
      "runtime.noop": {
        id: "runtime.noop",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        required_ports: []
      }
    }
  })
]);

const workflow = definition([
  { id: "noop", type: "built_in", uses: "runtime.noop" }
]);

function definition(nodes: WorkflowNode[]): WorkflowDefinition {
  return {
    id: "runner-engine-test",
    type: "workflow",
    mode: "read_only",
    directory: "/tmp/runner-engine-test",
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    input_schema_content: { type: "object" },
    output_schema_content: { type: "object" },
    capabilities: ["runtime"],
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

function agentRuntime(): AgentRuntimePort {
  return {
    describe: () => ({
      id: "test-agent-runtime",
      display_name: "Test",
      supported_tool_protocols: [],
      supported_runtime_requirements: []
    }),
    validate: async () => undefined,
    runAgent: async () => ({ output: {} })
  };
}

function runInput({
  runId,
  stores = backends()
}: {
  readonly runId: string;
  readonly stores?: ReturnType<typeof backends>;
}): RunWorkflowInput {
  return {
    compiled: compileWorkflow({ workflow, registry }),
    workflow,
    invocation: {},
    config: {},
    run: {
      run_id: runId,
      workflow_id: workflow.id,
      attempt: 1,
      started_at: "2026-06-25T00:00:00.000Z"
    },
    backends: stores,
    builtIns: {},
    agentRuntime: agentRuntime()
  };
}

describe("runtime-neutral workflow runner engine", () => {
  it("treats the control-plane waiting hook as a durability boundary", async () => {
    const scheduler: WorkflowNodeScheduler<RunWorkflowInput> = async ({
      initialState
    }) => ({
      kind: "waiting_for_input",
      interrupt_id: "interrupt-waiting-boundary",
      checkpoint_id: "checkpoint-waiting-boundary",
      state: { ...initialState, run_status: "waiting_for_input" }
    });
    const failedState = vi.fn();
    const boundary = vi.fn(async () => {
      throw new Error("control plane unavailable");
    });

    await expect(runCompiledWorkflowWithScheduler({
      ...runInput({ runId: "engine-waiting-boundary" }),
      onWaitingState: boundary,
      onFailedState: failedState
    }, scheduler)).rejects.toMatchObject({
      code: "runtime_durability_recovery_required",
      details: {
        interrupt_id: "interrupt-waiting-boundary",
        checkpoint_id: "checkpoint-waiting-boundary"
      }
    });

    expect(boundary).toHaveBeenCalledOnce();
    expect(failedState).not.toHaveBeenCalled();
  });

  it("substitutes precompleted nodes using the canonical effective DAG", async () => {
    const cutpointWorkflow = definition([
      { id: "shared", type: "built_in", uses: "runtime.noop" },
      { id: "exclusive", type: "built_in", uses: "runtime.noop" },
      {
        id: "supplied",
        type: "built_in",
        uses: "runtime.noop",
        after: ["shared", "exclusive"]
      },
      {
        id: "live",
        type: "built_in",
        uses: "runtime.noop",
        after: ["shared"]
      }
    ]);
    const executed: string[] = [];
    const scheduled: string[] = [];
    const input = {
      ...runInput({ runId: "engine-precompleted-cutpoint" }),
      workflow: cutpointWorkflow,
      compiled: compileWorkflow({
        workflow: cutpointWorkflow,
        registry,
        reducers: { steps: "object_merge" }
      }),
      precompleted_steps: { supplied: { fixture: true } },
      builtIns: {
        "runtime.noop": async ({ node }) => {
          executed.push(node.id);
          return { node: node.id };
        }
      }
    } satisfies RunWorkflowInput;
    const scheduler: WorkflowNodeScheduler<RunWorkflowInput> = async ({
      initialState,
      nodes,
      runNode
    }) => {
      scheduled.push(...nodes.map((node) => node.id));
      let state = initialState;
      for (const node of nodes) {
        const result = await runNode(node, state);
        if (result.kind !== "completed") throw new Error("unexpected wait");
        state = applyWorkflowGraphUpdate(state, result.update);
      }
      return { kind: "completed", state };
    };

    const result = await runCompiledWorkflowWithScheduler(input, scheduler);

    expect(scheduled).toEqual(["shared", "live"]);
    expect(executed).toEqual(["shared", "live"]);
    expect(result).toMatchObject({
      status: "succeeded",
      state: { steps: { supplied: { fixture: true } } },
      output: {
        supplied: { fixture: true },
        live: { node: "live" }
      }
    });
  });

  it("rejects unknown and schema-invalid precompleted outputs before scheduling", async () => {
    const scheduler = vi.fn<WorkflowNodeScheduler<RunWorkflowInput>>();
    await expect(runCompiledWorkflowWithScheduler({
      ...runInput({ runId: "engine-precompleted-unknown" }),
      precompleted_steps: { missing: {} }
    }, scheduler)).rejects.toMatchObject({ code: "runtime_state_invalid" });
    await expect(runCompiledWorkflowWithScheduler({
      ...runInput({ runId: "engine-precompleted-schema" }),
      precompleted_steps: { noop: "invalid" }
    }, scheduler)).rejects.toMatchObject({
      code: "runtime_node_output_schema_invalid"
    });
    await expect(runCompiledWorkflowWithScheduler({
      ...runInput({ runId: "engine-precompleted-json" }),
      precompleted_steps: {
        noop: undefined as never
      }
    }, scheduler)).rejects.toMatchObject({ code: "runtime_invalid_json" });
    expect(scheduler).not.toHaveBeenCalled();
  });

  it("binds precompleted outputs into the durable execution identity", async () => {
    const stores = backends();
    const input = runInput({
      stores,
      runId: "engine-precompleted-identity"
    });
    await ensureWorkflowExecutionIdentity({
      ...input,
      precompleted_steps: { noop: { fixture: "first" } }
    }, input.run.run_id);

    await expect(ensureWorkflowExecutionIdentity({
      ...input,
      precompleted_steps: { noop: { fixture: "changed" } }
    }, input.run.run_id)).rejects.toMatchObject({
      code: "runtime_checkpoint_schema_mismatch"
    });
  });

  it("does not apply the full workflow output schema to a bounded through-node run", async () => {
    const scheduler: WorkflowNodeScheduler<RunWorkflowInput> = async ({
      initialState,
      nodes,
      runNode
    }) => {
      const node = nodes[0];
      if (node === undefined) throw new Error("missing test node");
      const result = await runNode(node, initialState);
      if (result.kind !== "completed") throw new Error("unexpected wait");
      return { kind: "completed", state: { ...initialState, ...result.update } };
    };
    const invalidFullOutput = {
      ...runInput({ runId: "engine-full-output-validation" }),
      workflow: { ...workflow, output_schema_content: { type: "string" } },
      builtIns: { "runtime.noop": async () => ({}) }
    } satisfies RunWorkflowInput;
    await expect(runCompiledWorkflowWithScheduler(invalidFullOutput, scheduler))
      .rejects.toThrow("Final workflow output failed schema validation");

    const partial = {
      ...runInput({ runId: "engine-partial-output-validation" }),
      workflow: { ...workflow, output_schema_content: { type: "string" } },
      executionScope: { kind: "through_node", node_id: "noop" },
      builtIns: { "runtime.noop": async () => ({}) }
    } satisfies RunWorkflowInput;
    await expect(runCompiledWorkflowWithScheduler(partial, scheduler))
      .resolves.toMatchObject({ status: "succeeded", output: {} });
  });

  it("saves a terminal failed checkpoint when the scheduler fails", async () => {
    const stores = backends();
    const input = runInput({
      stores,
      runId: "engine-fails"
    });
    const failingScheduler: WorkflowNodeScheduler<RunWorkflowInput> = async () => {
      throw new Error("scheduler crashed");
    };

    await expect(
      runCompiledWorkflowWithScheduler(input, failingScheduler)
    ).rejects.toThrow("scheduler crashed");

    await expect(stores.checkpoints.load("engine-fails")).resolves.toMatchObject({
      checkpoint_id: "terminal-engine-fails-failed",
      state: { run_status: "failed" }
    });
  });

  it("observes an exact failed node state without replacing the runtime cause", async () => {
    const stores = backends();
    const runtimeFailure = new Error("built-in exploded");
    let observedState: LunaRuntimeState | undefined;
    const input = {
      ...runInput({ stores, runId: "engine-node-fails" }),
      builtIns: {
        "runtime.noop": async () => {
          throw runtimeFailure;
        }
      },
      onFailedState: (state) => {
        observedState = state;
        throw new Error("observer must be isolated");
      }
    } satisfies RunWorkflowInput;
    const scheduler: WorkflowNodeScheduler<RunWorkflowInput> = async ({
      initialState,
      nodes,
      runNode
    }) => {
      await runNode(nodes[0], initialState);
      throw new Error("unreachable");
    };

    await expect(
      runCompiledWorkflowWithScheduler(input, scheduler)
    ).rejects.toBe(runtimeFailure);

    expect(observedState).toMatchObject({
      run_status: "failed",
      primary_failure: {
        node_id: "noop",
        status: "failed"
      },
      node_statuses: {
        noop: {
          status: "failed",
          attempt: 1
        }
      },
      attempts: {
        noop: {
          count: 1,
          history: [{ attempt: 1, status: "failed" }]
        }
      }
    });
    await expect(stores.checkpoints.load("engine-node-fails")).resolves.toMatchObject({
      state: { run_status: "failed" }
    });
  });

  it("requires recovery without observing a terminal failure when checkpoint recovery fails", async () => {
    const stores = backends();
    const checkpointStore = stores.checkpoints;
    const runtimeFailure = new Error("built-in exploded");
    const checkpointFailure = new Error("checkpoint unavailable");
    let observedState: LunaRuntimeState | undefined;
    stores.checkpoints = {
      ...checkpointStore,
      async load(threadId, options) {
        if (options === undefined) {
          throw checkpointFailure;
        }
        return await checkpointStore.load(threadId, options);
      }
    };
    const input = {
      ...runInput({ stores, runId: "engine-checkpoint-load-fails" }),
      builtIns: {
        "runtime.noop": async () => {
          throw runtimeFailure;
        }
      },
      onFailedState: (state) => {
        observedState = state;
      }
    } satisfies RunWorkflowInput;
    const scheduler: WorkflowNodeScheduler<RunWorkflowInput> = async ({
      initialState,
      nodes,
      runNode
    }) => {
      await runNode(nodes[0], initialState);
      throw new Error("unreachable");
    };

    const outcome = await runCompiledWorkflowWithScheduler(input, scheduler)
      .catch((cause: unknown) => cause);
    expect(outcome).toBeInstanceOf(RuntimeDurabilityRecoveryRequiredError);
    expect(outcome).toMatchObject({
      code: "runtime_durability_recovery_required",
      cause: checkpointFailure,
      details: {
        run_id: "engine-checkpoint-load-fails",
        runtime_failure_kind: runtimeFailure.name
      }
    });
    expect(observedState).toBeUndefined();
    expect((await stores.events.list("engine-checkpoint-load-fails")))
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "run.failed" })
      ]));
  });

  it("records workflow, node, and built-in spans as the execution source of truth", async () => {
    const stores = backends();
    const observability = createWorkflowObservability({
      run: { id: "engine-trace", workflowId: workflow.id, attempt: 1 },
      sinks: [
        createRuntimeLogProjectionSink({
          runId: "engine-trace",
          store: stores.runtimeLogs
        })
      ],
      idGenerator: (() => {
        let index = 0;
        return () => ["trace-1", "span-workflow", "span-node", "span-built-in"][index++] ?? `span-${index}`;
      })(),
      now: (() => {
        let ms = 0;
        return () => {
          ms += 10;
          return new Date(`2026-06-28T00:00:00.${String(ms).padStart(3, "0")}Z`);
        };
      })()
    });
    const input = {
      ...runInput({ stores, runId: "engine-trace" }),
      observability,
      builtIns: {
        "runtime.noop": async () => ({})
      }
    } satisfies RunWorkflowInput;
    const scheduler: WorkflowNodeScheduler<RunWorkflowInput> = async ({
      input,
      initialState,
      nodes,
      runtimeContext,
      runNode
    }) => {
      const result = await runNode(nodes[0], initialState);
      if (result.kind !== "completed") {
        throw new Error("unexpected wait");
      }
      return {
        kind: "completed",
        state: {
          ...initialState,
          ...result.update
        }
      };
    };

    await runCompiledWorkflowWithScheduler(input, scheduler);

    const ended = observability
      .records()
      .filter((record) => record.type === "span.ended")
      .map((record) => record.span);
    expect(ended.map((span) => span.name)).toEqual([
      "built_in.runtime.noop",
      "node.noop",
      "workflow.run"
    ]);
    expect(ended[0]).toMatchObject({
      trace_id: "trace-1",
      parent_span_id: "span-node",
      kind: "built_in",
      capability_id: "runtime.noop"
    });
    expect(ended[1]).toMatchObject({
      parent_span_id: "span-workflow",
      kind: "node",
      node_id: "noop"
    });
    await expect(stores.runtimeLogs.list("engine-trace")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "span started: workflow.run" }),
        expect.objectContaining({ message: "span ok: workflow.run; duration_ms=80" })
      ])
    );
  });

  it("keeps committed success when workflow span end and flush telemetry fail", async () => {
    const stores = backends();
    const telemetryFailure = new Error("required telemetry unavailable");
    const observability = createWorkflowObservability({
      run: { id: "engine-post-commit-telemetry", workflowId: workflow.id, attempt: 1 },
      sinks: [
        {
          id: "required-post-commit",
          required: true,
          emit(record) {
            if (record.type === "span.ended" && record.span.kind === "workflow") {
              throw telemetryFailure;
            }
          },
          async flush() {
            throw telemetryFailure;
          }
        }
      ]
    });
    const input = {
      ...runInput({ stores, runId: "engine-post-commit-telemetry" }),
      observability,
      builtIns: { "runtime.noop": async () => ({}) }
    } satisfies RunWorkflowInput;
    const scheduler: WorkflowNodeScheduler<RunWorkflowInput> = async ({
      initialState,
      nodes,
      runNode
    }) => {
      const result = await runNode(nodes[0], initialState);
      if (result.kind !== "completed") {
        throw new Error("unexpected wait");
      }
      return {
        kind: "completed",
        state: { ...initialState, ...result.update }
      };
    };

    await expect(runCompiledWorkflowWithScheduler(input, scheduler))
      .resolves.toMatchObject({
        status: "succeeded",
        state: { run_status: "succeeded" }
      });
    await expect(stores.checkpoints.load("engine-post-commit-telemetry"))
      .resolves.toMatchObject({ state: { run_status: "succeeded" } });
  });

  it("does not retry a committed node when its succeeded telemetry fails", async () => {
    const stores = backends();
    const telemetryFailure = new Error("node succeeded telemetry unavailable");
    const execute = vi.fn(async () => ({}));
    const observability = createWorkflowObservability({
      run: { id: "engine-node-telemetry", workflowId: workflow.id, attempt: 1 },
      sinks: [
        {
          id: "required-node-telemetry",
          required: true,
          emit(record) {
            if (
              record.type === "span.event" &&
              record.event.name === "node.succeeded"
            ) {
              throw telemetryFailure;
            }
          }
        }
      ]
    });
    const input = {
      ...runInput({ stores, runId: "engine-node-telemetry" }),
      observability,
      builtIns: { "runtime.noop": execute }
    } satisfies RunWorkflowInput;
    const scheduler: WorkflowNodeScheduler<RunWorkflowInput> = async ({
      initialState,
      nodes,
      runNode
    }) => {
      const result = await runNode(nodes[0], initialState);
      if (result.kind !== "completed") {
        throw new Error("unexpected wait");
      }
      return {
        kind: "completed",
        state: { ...initialState, ...result.update }
      };
    };

    await expect(runCompiledWorkflowWithScheduler(input, scheduler))
      .resolves.toMatchObject({
        status: "succeeded",
        state: {
          run_status: "succeeded",
          node_statuses: { noop: { status: "succeeded" } }
        }
      });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("propagates the authoritative pre-node barrier before entering an executor", async () => {
    const execute = vi.fn(async () => ({}));
    const barrierFailure = new Error("resume stage fsync failed");
    const barrier = vi.fn(async () => {
      throw barrierFailure;
    });
    const input = {
      ...runInput({ runId: "engine-pre-node-barrier" }),
      onBeforeNodeExecution: barrier,
      builtIns: { "runtime.noop": execute }
    } satisfies RunWorkflowInput;
    const scheduler: WorkflowNodeScheduler<RunWorkflowInput> = async ({
      initialState,
      nodes,
      runNode
    }) => {
      const result = await runNode(nodes[0], initialState);
      if (result.kind !== "completed") throw new Error("unexpected wait");
      return {
        kind: "completed",
        state: applyWorkflowGraphUpdate(initialState, result.update)
      };
    };

    await expect(runCompiledWorkflowWithScheduler(input, scheduler)).rejects.toThrow();
    expect(barrier).toHaveBeenCalledWith({ node_id: "noop", attempt: 1 });
    expect(execute).not.toHaveBeenCalled();
  });

  it("publishes one final observability summary after the workflow span closes", async () => {
    const stores = backends();
    const observability = createWorkflowObservability({
      run: { id: "engine-summary", workflowId: workflow.id, attempt: 1 },
      sinks: [],
      idGenerator: (() => {
        let index = 0;
        return () => ["trace-summary", "span-workflow", "span-node", "span-built-in"][index++] ?? `span-${index}`;
      })(),
      now: (() => {
        let ms = 0;
        return () => {
          ms += 10;
          return new Date(`2026-06-28T00:00:00.${String(ms).padStart(3, "0")}Z`);
        };
      })()
    });
    const published: unknown[] = [];
    const input = {
      ...runInput({ stores, runId: "engine-summary" }),
      observability,
      artifactPublisher: {
        publish: async ({ node_id, value }: {
          readonly node_id: string;
          readonly value: unknown;
        }) => {
          published.push(value);
          return { id: "summary", uri: "memory://summary", node_id };
        }
      },
      builtIns: {
        "runtime.noop": async () => ({})
      }
    } satisfies RunWorkflowInput;
    const scheduler: WorkflowNodeScheduler<RunWorkflowInput> = async ({
      initialState,
      nodes,
      runNode
    }) => {
      const result = await runNode(nodes[0], initialState);
      if (result.kind !== "completed") {
        throw new Error("unexpected wait");
      }
      return {
        kind: "completed",
        state: {
          ...initialState,
          ...result.update
        }
      };
    };

    await runCompiledWorkflowWithScheduler(input, scheduler);

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      spans: {
        total: 3
      }
    });
  });
});
