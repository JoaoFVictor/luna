import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";
import {
  resumeCompiledWorkflow,
  runCompiledWorkflow
} from "../../../src/runtime/langgraph/workflow-runner.js";
import {
  CheckpointWriteAcceptanceUnknownError,
  nodeOutputCheckpointId
} from "../../../src/runtime/workflow/checkpoints.js";
import { NODE_OUTPUT_JOURNAL_CHANNEL } from "../../../src/runtime/workflow/node-durability.js";

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "runtime",
    kind: "execution",
    version: "1.0.0",
    built_ins: Object.fromEntries(
      ["runtime.pre", "runtime.effect"].map((id) => [
        id,
        {
          id,
          input_schema: { type: "object" },
          output_schema: { type: "object" },
          required_ports: []
        }
      ])
    )
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
  })
]);

const workflow: WorkflowDefinition = {
  id: "checkpoint-write-acceptance-unknown",
  type: "workflow",
  mode: "read_only",
  directory: "/tmp/checkpoint-write-acceptance-unknown",
  input_schema: "input.schema.json",
  output_schema: "output.schema.json",
  input_schema_content: { type: "object" },
  output_schema_content: { type: "object" },
  capabilities: ["runtime", "approval"],
  graph: {
    nodes: [
      { id: "pre", type: "built_in", uses: "runtime.pre" },
      {
        id: "approve",
        type: "human_gate",
        uses: "approval.human",
        after: ["pre"]
      },
      {
        id: "effect",
        type: "built_in",
        uses: "runtime.effect",
        after: ["approve"]
      }
    ]
  },
  revision: "revision-1",
  external_definition_digests: {},
  execution: { max_concurrency: 1 },
  requires: { repository: false },
  observability: {
    exporters: { runtime_log: { enabled: true, required: false } }
  },
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

describe("checkpoint write acceptance-unknown recovery", () => {
  it("does not write a failed terminal and reuses an exactly committed node marker", async () => {
    const stores = backends();
    const compiled = compileWorkflow({ workflow, registry });
    const runId = "run-checkpoint-write-acceptance-unknown";
    const waiting = await runCompiledWorkflow({
      compiled,
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
      builtIns: { "runtime.pre": async () => ({ ready: true }) },
      agentRuntime: {} as AgentRuntimePort
    });
    if (waiting.status !== "waiting_for_input") {
      throw new Error("expected workflow to wait for input");
    }

    const durableCheckpoints = stores.checkpoints;
    const effectCheckpointId = nodeOutputCheckpointId(
      runId,
      compiled.workflow_id,
      compiled.workflow_revision,
      "effect"
    );
    const saveFailure = new Error("save response lost after commit");
    const verificationFailure = new Error("readback temporarily unavailable");
    let failExactReadback = false;
    let outputWriteAttempts = 0;
    let completionWriteAttempts = 0;
    stores.checkpoints = {
      ...durableCheckpoints,
      async saveWrites(writes) {
        const effectOutput = writes.some(
          (write) =>
            write.checkpoint_id === effectCheckpointId && write.index === 0
        );
        const effectCompletion = writes.some(
          (write) =>
            write.checkpoint_id === effectCheckpointId && write.index === 1
        );
        if (effectOutput) {
          outputWriteAttempts += 1;
        }
        if (effectCompletion) {
          completionWriteAttempts += 1;
        }
        await durableCheckpoints.saveWrites(writes);
        if (effectCompletion && completionWriteAttempts === 1) {
          failExactReadback = true;
          throw saveFailure;
        }
      },
      async listWrites(threadId, checkpointNs, checkpointId) {
        if (checkpointId === effectCheckpointId && failExactReadback) {
          failExactReadback = false;
          throw verificationFailure;
        }
        return await durableCheckpoints.listWrites(
          threadId,
          checkpointNs,
          checkpointId
        );
      }
    };

    let effectExecutions = 0;
    const failedState = vi.fn();
    const resumeInput = {
      compiled,
      workflow,
      checkpoint_id: waiting.checkpoint_id,
      thread_id: runId,
      interrupt_id: waiting.interrupt_id,
      decision: { approved: true },
      backends: stores,
      builtIns: {
        "runtime.effect": async () => {
          effectExecutions += 1;
          return { applied: true };
        }
      },
      agentRuntime: {} as AgentRuntimePort,
      onFailedState: failedState
    };

    const inconclusive = await resumeCompiledWorkflow(resumeInput).catch(
      (cause: unknown) => cause
    );
    expect(inconclusive).toBeInstanceOf(
      CheckpointWriteAcceptanceUnknownError
    );
    expect(inconclusive).toMatchObject({
      code: "runtime_checkpoint_write_acceptance_unknown",
      saveCause: saveFailure,
      verificationCause: verificationFailure
    });
    expect(effectExecutions).toBe(1);
    expect(outputWriteAttempts).toBe(1);
    expect(completionWriteAttempts).toBe(1);
    expect(failedState).not.toHaveBeenCalled();
    await expect(stores.checkpoints.load(runId, {
      checkpointId: `terminal-${runId}-failed`,
      checkpointNs: ""
    })).resolves.toBeUndefined();
    const failureEvents = (await stores.events.list(runId)).filter(
      (event) =>
        event.type === "run.failed" ||
        (event.type === "node.failed" && event.node_id === "effect")
    );
    expect(failureEvents).toEqual([]);

    const resumed = await resumeCompiledWorkflow(resumeInput);
    expect(resumed).toMatchObject({
      status: "succeeded",
      output: { applied: true },
      state: { steps: { effect: { applied: true } } }
    });
    expect(effectExecutions).toBe(1);
    expect(outputWriteAttempts).toBe(1);
    expect(completionWriteAttempts).toBe(1);

    const exactWrites = await durableCheckpoints.listWrites(
      runId,
      "",
      effectCheckpointId
    );
    expect(exactWrites).toHaveLength(2);
    expect(exactWrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_id: "effect",
          index: 0,
          channel: NODE_OUTPUT_JOURNAL_CHANNEL,
          value: {
            kind: "luna.runtime.node-output-envelope",
            schema_version: 2,
            output: { applied: true }
          }
        }),
        expect.objectContaining({
          task_id: "effect",
          index: 1,
          channel: "node_completion"
        })
      ])
    );
  });
});
