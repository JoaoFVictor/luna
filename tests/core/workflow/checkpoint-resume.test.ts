import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import {
  resumeCompiledWorkflow,
  runCompiledWorkflow
} from "../../../src/runtime/langgraph/workflow-runner.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";
import { createFilesystemInterruptStore } from "../../../src/runtime/backends/filesystem/interrupts.js";
import {
  createSqliteCheckpointStore,
  sqliteCheckpointFile
} from "../../../src/runtime/backends/sqlite/checkpoints.js";

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
      },
      "runtime.workspace": {
        id: "runtime.workspace",
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

const workspaceWorkflow: WorkflowDefinition = {
  ...workflow,
  id: "workspace-checkpoint-test",
  graph: {
    nodes: [
      { id: "capture", type: "built_in", uses: "runtime.workspace" },
      { id: "approve", type: "human_gate", uses: "approval.human", after: ["capture"] },
      {
        id: "after",
        type: "built_in",
        uses: "runtime.after",
        after: ["approve"],
        input: { cwd: { expression: "$.workspace.path" } }
      }
    ]
  }
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

describe("workflow runner checkpoint resume", () => {
  it("rehydrates captured workspace context from checkpoint writes on resume", async () => {
    const stores = backends();
    const compiled = compileWorkflow({ workflow: workspaceWorkflow, registry });
    const builtInMetadata = (node: { capability_id: string }) =>
      node.capability_id === "runtime.workspace"
        ? { capturesWorkspace: true }
        : {};

    const waiting = await runCompiledWorkflow({
      compiled,
      workflow: workspaceWorkflow,
      invocation: {},
      config: {},
      run: {
        run_id: "run-resume-workspace",
        workflow_id: "workspace-checkpoint-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: stores,
      builtIns: {
        "runtime.workspace": async () => ({
          run_id: "run-resume-workspace",
          path: "/tmp/workspace",
          preserved: false,
          reason: "active"
        })
      },
      builtInMetadata,
      agentRuntime: {} as AgentRuntimePort
    });
    expect(waiting.status).toBe("waiting_for_input");
    if (waiting.status !== "waiting_for_input") {
      throw new Error("expected workflow to wait for input");
    }

    const resumed = await resumeCompiledWorkflow({
      compiled,
      workflow: workspaceWorkflow,
      checkpoint_id: waiting.checkpoint_id,
      thread_id: "run-resume-workspace",
      interrupt_id: waiting.interrupt_id,
      decision: { approved: true },
      backends: stores,
      builtIns: {
        "runtime.workspace": async () => {
          throw new Error("capture should not rerun");
        },
        "runtime.after": async ({ input }) => {
          expect(input).toEqual({ cwd: "/tmp/workspace" });
          return { done: true };
        }
      },
      builtInMetadata,
      agentRuntime: {} as AgentRuntimePort
    });

    expect(resumed.status).toBe("succeeded");
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
    const waiting = await runCompiledWorkflow({
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
        "runtime.pre": async () => ({ before: true })
      },
      agentRuntime: {} as AgentRuntimePort
    });
    expect(waiting.status).toBe("waiting_for_input");
    if (waiting.status !== "waiting_for_input") {
      throw new Error("expected workflow to wait for input");
    }

    const resumed = await resumeCompiledWorkflow({
      compiled,
      workflow: definition,
      checkpoint_id: waiting.checkpoint_id,
      thread_id: "run-resume-context",
      interrupt_id: waiting.interrupt_id,
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
        "runtime.pre": async () => ({ before: true })
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
        "runtime.pre": async () => ({ before: true })
      },
      agentRuntime: {} as AgentRuntimePort
    });
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
            throw new Error("downstream failed after decision persistence");
          }
        }
      })
    ).rejects.toThrow("downstream failed after decision persistence");

    const resumed = await resumeCompiledWorkflow({
        ...resumeInput,
        builtIns: {
          "runtime.after": async ({ state }) => {
            expect(state.steps.approve).toEqual({ approved: true });
            return { done: true };
        }
      }
    });

    expect(resumed.status).toBe("succeeded");
  });

  it("resumes idempotently across durable checkpoint and filesystem interrupt stores", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-resume-durable-"));
    const checkpointFile = sqliteCheckpointFile(path.join(root, "checkpoints"));
    const interruptRoot = path.join(root, "interrupts");
    const sharedStores = {
      artifacts: createMemoryArtifactManifestStore(),
      events: createMemoryEventStore(),
      runtimeLogs: createMemoryRuntimeLogStore()
    };

    try {
      const firstStores = {
        ...sharedStores,
        checkpoints: createSqliteCheckpointStore({ filePath: checkpointFile }),
        interrupts: createFilesystemInterruptStore({ root: interruptRoot })
      };
      const compiled = compileWorkflow({ workflow, registry });
      const waiting = await runCompiledWorkflow({
        compiled,
        workflow,
        invocation: {},
        config: {},
        run: {
          run_id: "run-durable-resume",
          workflow_id: "checkpoint-test",
          attempt: 1,
          started_at: "2026-06-25T00:00:00.000Z"
        },
        backends: firstStores,
        builtIns: {
          "runtime.pre": async () => ({ before: true })
        },
        agentRuntime: {} as AgentRuntimePort
      });
      expect(waiting.status).toBe("waiting_for_input");
      if (waiting.status !== "waiting_for_input") {
        throw new Error("expected workflow to wait for input");
      }

      const restartedStores = {
        ...sharedStores,
        checkpoints: createSqliteCheckpointStore({ filePath: checkpointFile }),
        interrupts: createFilesystemInterruptStore({ root: interruptRoot })
      };
      let downstreamRuns = 0;
      const resumeInput = {
        compiled,
        workflow,
        checkpoint_id: waiting.checkpoint_id,
        thread_id: "run-durable-resume",
        interrupt_id: waiting.interrupt_id,
        decision: { approved: true },
        backends: restartedStores,
        agentRuntime: {} as AgentRuntimePort
      };

      const resumed = await resumeCompiledWorkflow({
        ...resumeInput,
        builtIns: {
          "runtime.after": async () => {
            downstreamRuns += 1;
            return { done: true };
          }
        }
      });
      expect(resumed.status).toBe("succeeded");

      const repeated = await resumeCompiledWorkflow({
        ...resumeInput,
        builtIns: {
          "runtime.after": async () => {
            downstreamRuns += 1;
            return { done: true };
          }
        }
      });
      expect(repeated.status).toBe("succeeded");
      expect(downstreamRuns).toBe(1);
      await expect(sharedStores.events.query({
        runId: "run-durable-resume",
        interruptId: waiting.interrupt_id
      })).resolves.toEqual([
        expect.objectContaining({ type: "luna.interrupt.created" }),
        expect.objectContaining({ type: "luna.interrupt.resumed" })
      ]);

      await expect(
        resumeCompiledWorkflow({
          ...resumeInput,
          decision: { approved: false },
          builtIns: {
            "runtime.after": async () => ({ done: true })
          }
        })
      ).rejects.toMatchObject({ code: "interrupt_conflict" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
