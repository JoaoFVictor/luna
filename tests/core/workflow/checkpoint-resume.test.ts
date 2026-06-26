import { describe, expect, it } from "vitest";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import {
  resumeCompiledWorkflow,
  type WorkflowAgentDefaults,
  runCompiledWorkflow
} from "../../../src/core/workflow/runner.js";
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
      "runtime.pre": {
        id: "runtime.pre",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        required_ports: []
      },
      "runtime.after": {
        id: "runtime.after",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        required_ports: []
      }
    }
  }),
  capabilityManifest({
    id: "approval",
    kind: "execution",
    version: "1.0.0",
    gates: {
      "approval.human": {
        id: "approval.human",
        input_schema: { type: "object" },
        decision_schema: { type: "object" },
        output_schema: {
          type: "object",
          additionalProperties: false,
          required: ["approved"],
          properties: { approved: { type: "boolean" } }
        },
        interrupt: "required"
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

const workflow: WorkflowDefinition = {
  id: "checkpoint-test",
  type: "workflow",
  mode: "read_only",
  directory: "/tmp/checkpoint-test",
  input_schema: "input.schema.json",
  output_schema: "output.schema.json",
  input_schema_content: { type: "object" },
  output_schema_content: { type: "object" },
  capabilities: ["runtime", "approval"],
  graph: {
    nodes: [
      { id: "pre", type: "built_in", uses: "runtime.pre" },
      { id: "approve", type: "human_gate", uses: "approval.human", after: ["pre"] },
      { id: "after", type: "built_in", uses: "runtime.after", after: ["approve"] }
    ]
  },
  revision: "revision-1",
  external_definition_digests: {},
  execution: { max_concurrency: 1 },
  requires: { repository: false },
  observability: { exporters: { runtime_log: { enabled: true, required: false } } },
  subagent_policy: { allow_write: false }
};

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
    validate: async () => undefined,
    runAgent: async () => ({ output })
  };
}

const agentDefaults: WorkflowAgentDefaults = {
  instructions: "Review after approval.",
  model_profile: { model: "openai/gpt-5", reasoning_effort: "medium" },
  tools: { tools: [], runtime_requirements: [] },
  context: {}
};

describe("workflow runner checkpoint resume", () => {
  it("waits for human input, stores ref-only checkpoint state, then resumes", async () => {
    const stores = backends();
    const compiled = compileWorkflow({ workflow, registry });

    const waiting = await runCompiledWorkflow({
      compiled,
      workflow,
      invocation: {},
      config: {},
      run: {
        run_id: "run-hitl",
        workflow_id: "checkpoint-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: stores,
      builtIns: {
        "runtime.pre": async () => ({ before: true }),
        "runtime.after": async ({ state }) => {
          expect(state.steps.pre).toEqual({ before: true });
          return { done: true };
        }
      },
      agentRuntime: {} as AgentRuntimePort
    });

    expect(waiting.status).toBe("waiting_for_input");
    const checkpoint = await stores.checkpoints.load("run-hitl");
    expect(checkpoint?.state).toEqual({
      state_schema_version: "2026-06",
      run_status: "waiting_for_input",
      interrupt_refs: [
        {
          id: "interrupt-run-hitl-approve",
          uri: "interrupt://run-hitl/approve",
          node_id: "approve"
        }
      ]
    });

    const resumed = await resumeCompiledWorkflow({
      compiled,
      workflow,
      checkpoint_id: "checkpoint-run-hitl-approve",
      thread_id: "run-hitl",
      interrupt_id: "interrupt-run-hitl-approve",
      decision: { approved: true },
      backends: stores,
      builtIns: {
        "runtime.pre": async () => ({ before: true }),
        "runtime.after": async ({ state }) => {
          expect(state.steps.pre).toEqual({ before: true });
          return { done: true };
        }
      },
      agentRuntime: {} as AgentRuntimePort
    });

    expect(resumed.status).toBe("succeeded");
    if (resumed.status !== "succeeded") {
      throw new Error("expected workflow to succeed");
    }
    expect(resumed.output).toEqual({ done: true });
  });

  it("persists the checkpoint before exposing the pending interrupt", async () => {
    const stores = backends();
    const originalCreate = stores.interrupts.create;
    stores.interrupts.create = async (record) => {
      await expect(
        stores.checkpoints.load(record.thread_id ?? "", {
          checkpointId: record.checkpoint_id
        })
      ).resolves.toBeDefined();
      return await originalCreate(record);
    };

    const waiting = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow, registry }),
      workflow,
      invocation: {},
      config: {},
      run: {
        run_id: "run-interrupt-order",
        workflow_id: "checkpoint-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: stores,
      builtIns: {
        "runtime.pre": async () => ({ before: true }),
        "runtime.after": async () => ({ done: true })
      },
      agentRuntime: {} as AgentRuntimePort
    });

    expect(waiting.status).toBe("waiting_for_input");
  });

  it("preserves invocation and config for downstream expression resolution after resume", async () => {
    const stores = backends();
    const definition: WorkflowDefinition = {
      ...workflow,
      graph: {
        nodes: [
          { id: "pre", type: "built_in", uses: "runtime.pre" },
          { id: "approve", type: "human_gate", uses: "approval.human", after: ["pre"] },
          {
            id: "after",
            type: "built_in",
            uses: "runtime.after",
            after: ["approve"],
            input: {
              title: { expression: "$.invocation.title" },
              threshold: { expression: "$.config.threshold" },
              pre: { expression: "$.steps.pre.before" },
              approved: { expression: "$.steps.approve.approved" }
            }
          }
        ]
      }
    };
    const compiled = compileWorkflow({ workflow: definition, registry });
    await runCompiledWorkflow({
      compiled,
      workflow: definition,
      invocation: { title: "keep-me" },
      config: { threshold: 3 },
      run: {
        run_id: "run-resume-context",
        workflow_id: "checkpoint-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: stores,
      builtIns: {
        "runtime.pre": async () => ({ before: true }),
        "runtime.after": async () => ({ done: false })
      },
      agentRuntime: {} as AgentRuntimePort
    });

    const resumed = await resumeCompiledWorkflow({
      compiled,
      workflow: definition,
      checkpoint_id: "checkpoint-run-resume-context-approve",
      thread_id: "run-resume-context",
      interrupt_id: "interrupt-run-resume-context-approve",
      decision: { approved: true },
      backends: stores,
      builtIns: {
        "runtime.pre": async () => ({ before: true }),
        "runtime.after": async ({ input }) => {
          expect(input).toEqual({
            title: "keep-me",
            threshold: 3,
            pre: true,
            approved: true
          });
          return { done: true };
        }
      },
      agentRuntime: {} as AgentRuntimePort
    });

    expect(resumed.status).toBe("succeeded");
  });

  it("rejects unsupported downstream agent runtime requirements before resume execution", async () => {
    const stores = backends();
    const definition: WorkflowDefinition = {
      ...workflow,
      graph: {
        nodes: [
          { id: "pre", type: "built_in", uses: "runtime.pre" },
          { id: "approve", type: "human_gate", uses: "approval.human", after: ["pre"] },
          {
            id: "review",
            type: "agent",
            agent: "reviewer",
            output_schema: "agents.output",
            runtime_requirements: ["mcp_tools"],
            after: ["approve"]
          }
        ]
      }
    };
    const compiled = compileWorkflow({ workflow: definition, registry });
    const runtime = agentRuntime({ reviewed: true });
    await runCompiledWorkflow({
      compiled,
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-resume-unsupported",
        workflow_id: "checkpoint-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: stores,
      builtIns: { "runtime.pre": async () => ({ before: true }) },
      agentRuntime: runtime,
      agentInputs: { review: agentDefaults }
    });

    await expect(
      resumeCompiledWorkflow({
        compiled,
        workflow: definition,
        checkpoint_id: "checkpoint-run-resume-unsupported-approve",
        thread_id: "run-resume-unsupported",
        interrupt_id: "interrupt-run-resume-unsupported-approve",
        decision: { approved: true },
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
        agentInputs: { review: agentDefaults }
      })
    ).rejects.toMatchObject({ code: "runtime_state_invalid" });
  });

  it("does not reject resume because an already completed upstream agent had unsupported requirements", async () => {
    const stores = backends();
    const definition: WorkflowDefinition = {
      ...workflow,
      graph: {
        nodes: [
          {
            id: "pre_review",
            type: "agent",
            agent: "reviewer",
            output_schema: "agents.output",
            runtime_requirements: ["mcp_tools"]
          },
          {
            id: "approve",
            type: "human_gate",
            uses: "approval.human",
            after: ["pre_review"]
          },
          { id: "after", type: "built_in", uses: "runtime.after", after: ["approve"] }
        ]
      }
    };
    const compiled = compileWorkflow({ workflow: definition, registry });
    const fullRuntime = agentRuntime({ reviewed: true });
    await runCompiledWorkflow({
      compiled,
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-upstream-agent-resume",
        workflow_id: "checkpoint-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: stores,
      builtIns: { "runtime.after": async () => ({ done: true }) },
      agentRuntime: fullRuntime,
      agentInputs: { pre_review: agentDefaults }
    });

    const resumed = await resumeCompiledWorkflow({
      compiled,
      workflow: definition,
      checkpoint_id: "checkpoint-run-upstream-agent-resume-approve",
      thread_id: "run-upstream-agent-resume",
      interrupt_id: "interrupt-run-upstream-agent-resume-approve",
      decision: { approved: true },
      backends: stores,
      builtIns: { "runtime.after": async () => ({ done: true }) },
      agentRuntime: {
        ...fullRuntime,
        describe: () => ({
          id: "limited",
          display_name: "Limited",
          supported_tool_protocols: ["local"],
          supported_runtime_requirements: ["tool_calling"]
        })
      },
      agentInputs: { pre_review: agentDefaults }
    });

    expect(resumed.status).toBe("succeeded");
  });

  it("validates resume decisions before publishing or running downstream nodes", async () => {
    const stores = backends();
    const compiled = compileWorkflow({ workflow, registry });
    await runCompiledWorkflow({
      compiled,
      workflow,
      invocation: {},
      config: {},
      run: {
        run_id: "run-invalid-decision",
        workflow_id: "checkpoint-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: stores,
      builtIns: {
        "runtime.pre": async () => ({ before: true }),
        "runtime.after": async () => ({ done: true })
      },
      agentRuntime: {} as AgentRuntimePort
    });
    let downstreamRan = false;

    await expect(
      resumeCompiledWorkflow({
        compiled,
        workflow,
        checkpoint_id: "checkpoint-run-invalid-decision-approve",
        thread_id: "run-invalid-decision",
        interrupt_id: "interrupt-run-invalid-decision-approve",
        decision: { approved: "yes" },
        backends: stores,
        builtIns: {
          "runtime.pre": async () => ({ before: true }),
          "runtime.after": async () => {
            downstreamRan = true;
            return { done: true };
          }
        },
        agentRuntime: {} as AgentRuntimePort
      })
    ).rejects.toMatchObject({ code: "runtime_node_output_schema_invalid" });
    expect(downstreamRan).toBe(false);
  });

  it("retries resume idempotently after the decision was saved but downstream failed", async () => {
    const stores = backends();
    const compiled = compileWorkflow({ workflow, registry });
    await runCompiledWorkflow({
      compiled,
      workflow,
      invocation: {},
      config: {},
      run: {
        run_id: "run-resume-retry",
        workflow_id: "checkpoint-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: stores,
      builtIns: {
        "runtime.pre": async () => ({ before: true }),
        "runtime.after": async () => ({ done: true })
      },
      agentRuntime: {} as AgentRuntimePort
    });
    let attempts = 0;
    const resumeInput = {
      compiled,
      workflow,
      checkpoint_id: "checkpoint-run-resume-retry-approve",
      thread_id: "run-resume-retry",
      interrupt_id: "interrupt-run-resume-retry-approve",
      decision: { approved: true },
      backends: stores,
      agentRuntime: {} as AgentRuntimePort
    };

    await expect(
      resumeCompiledWorkflow({
        ...resumeInput,
        builtIns: {
          "runtime.after": async () => {
            attempts += 1;
            throw new Error("downstream failed after decision persistence");
          }
        }
      })
    ).rejects.toThrow("downstream failed after decision persistence");

    const resumed = await resumeCompiledWorkflow({
      ...resumeInput,
      builtIns: {
        "runtime.after": async ({ state }) => {
          attempts += 1;
          expect(state.steps.approve).toEqual({ approved: true });
          return { done: true };
        }
      }
    });

    expect(resumed.status).toBe("succeeded");
    expect(attempts).toBe(2);
  });

  it("rejects incompatible workflow revision and state schema resumes", async () => {
    const stores = backends();
    await stores.checkpoints.save({
      thread_id: "run-bad",
      checkpoint_id: "checkpoint-bad",
      state_schema_version: "2026-06",
      state: { state_schema_version: "2026-06", run_status: "waiting_for_input" },
      metadata: { workflow_revision: "old-revision", resume_node_id: "approve" }
    });

    await expect(
      resumeCompiledWorkflow({
        compiled: compileWorkflow({ workflow, registry }),
        workflow,
        checkpoint_id: "checkpoint-bad",
        thread_id: "run-bad",
        interrupt_id: "interrupt-run-bad-approve",
        decision: { approved: true },
        backends: stores,
        builtIns: { "runtime.after": async () => ({ done: true }) },
        agentRuntime: {} as AgentRuntimePort
      })
    ).rejects.toMatchObject({ code: "runtime_checkpoint_schema_mismatch" });

    await stores.checkpoints.save({
      thread_id: "run-schema",
      checkpoint_id: "checkpoint-schema",
      state_schema_version: "2025-01",
      state: { state_schema_version: "2026-06" },
      metadata: { workflow_revision: workflow.revision, resume_node_id: "approve" }
    });

    await expect(
      resumeCompiledWorkflow({
        compiled: compileWorkflow({ workflow, registry }),
        workflow,
        checkpoint_id: "checkpoint-schema",
        thread_id: "run-schema",
        interrupt_id: "interrupt-run-schema-approve",
        decision: { approved: true },
        backends: stores,
        builtIns: { "runtime.after": async () => ({ done: true }) },
        agentRuntime: {} as AgentRuntimePort
      })
    ).rejects.toMatchObject({ code: "runtime_checkpoint_schema_mismatch" });
  });
});
