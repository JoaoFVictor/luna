import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import { RuntimeDurabilityRecoveryRequiredError } from "../../../src/core/runtime/errors.js";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";
import {
  resumeCompiledWorkflow,
  runCompiledWorkflow
} from "../../../src/runtime/langgraph/workflow-runner.js";

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "runtime",
    kind: "execution",
    version: "1.0.0",
    built_ins: {
      "runtime.effect": {
        id: "runtime.effect",
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
  })
]);

const workflow: WorkflowDefinition = {
  id: "stale-multi-gate-resume",
  type: "workflow",
  mode: "read_only",
  directory: "/tmp/stale-multi-gate-resume",
  input_schema: "input.schema.json",
  output_schema: "output.schema.json",
  input_schema_content: { type: "object" },
  output_schema_content: { type: "object" },
  capabilities: ["runtime", "approval"],
  graph: {
    nodes: [
      { id: "before_a", type: "built_in", uses: "runtime.effect" },
      {
        id: "gate_a",
        type: "human_gate",
        uses: "approval.human",
        after: ["before_a"],
        artifacts: [{
          path: "gate-a.json",
          publisher: "artifacts.manifest_publisher",
          source: { expression: "$.steps.gate_a" },
          format: "json",
          required: true
        }]
      },
      {
        id: "between_gates",
        type: "built_in",
        uses: "runtime.effect",
        after: ["gate_a"]
      },
      {
        id: "gate_b",
        type: "human_gate",
        uses: "approval.human",
        after: ["between_gates"]
      },
      {
        id: "after_b",
        type: "built_in",
        uses: "runtime.effect",
        after: ["gate_b"]
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

describe("stale resume after multiple human gates", () => {
  it("rejects gate A after gate B completed without mutating B or replaying effects", async () => {
    const stores = backends();
    const compiled = compileWorkflow({ workflow, registry });
    const runId = "run-stale-multi-gate-resume";
    const executions = new Map<string, number>();
    const executeEffect = vi.fn(async ({ node }: { node: { id: string } }) => {
      const count = (executions.get(node.id) ?? 0) + 1;
      executions.set(node.id, count);
      return { node_id: node.id, execution: count };
    });
    const publishArtifact = vi.fn(async ({
      node_id,
      path: artifactPath
    }: {
      node_id: string;
      path: string;
    }) => ({
      id: artifactPath,
      uri: `memory://${artifactPath}`,
      node_id
    }));
    const common = {
      compiled,
      workflow,
      backends: stores,
      builtIns: { "runtime.effect": executeEffect },
      artifactPublisher: { publish: publishArtifact },
      agentRuntime: {} as AgentRuntimePort
    };

    const atGateA = await runCompiledWorkflow({
      ...common,
      invocation: {},
      config: {},
      run: {
        run_id: runId,
        workflow_id: workflow.id,
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      }
    });
    expect(atGateA).toMatchObject({
      status: "waiting_for_input",
      interrupt_id: `interrupt-${runId}-gate_a`,
      checkpoint_id: `checkpoint-${runId}-gate_a`,
      state: {
        interrupt_refs: [{
          id: `interrupt-${runId}-gate_a`,
          uri: `interrupt://${runId}/gate_a`,
          node_id: "gate_a"
        }]
      }
    });
    if (atGateA.status !== "waiting_for_input") {
      throw new Error("expected gate A to wait for input");
    }

    const atGateB = await resumeCompiledWorkflow({
      ...common,
      thread_id: runId,
      checkpoint_id: atGateA.checkpoint_id,
      interrupt_id: atGateA.interrupt_id,
      decision: { approved: true }
    });
    expect(atGateB).toMatchObject({
      status: "waiting_for_input",
      interrupt_id: `interrupt-${runId}-gate_b`,
      checkpoint_id: `checkpoint-${runId}-gate_b`,
      state: {
        interrupt_refs: [
          {
            id: `interrupt-${runId}-gate_a`,
            uri: `interrupt://${runId}/gate_a`,
            node_id: "gate_a"
          },
          {
            id: `interrupt-${runId}-gate_b`,
            uri: `interrupt://${runId}/gate_b`,
            node_id: "gate_b"
          }
        ]
      }
    });
    if (atGateB.status !== "waiting_for_input") {
      throw new Error("expected gate B to wait for input");
    }
    expect(publishArtifact).toHaveBeenCalledTimes(1);

    const effectsBeforePendingStaleResume = executeEffect.mock.calls.length;
    await expect(resumeCompiledWorkflow({
      ...common,
      thread_id: runId,
      checkpoint_id: atGateA.checkpoint_id,
      interrupt_id: atGateA.interrupt_id,
      decision: { approved: true }
    })).rejects.toMatchObject({
      code: "interrupt_stale",
      details: { later_interrupt_id: atGateB.interrupt_id }
    });
    expect(executeEffect).toHaveBeenCalledTimes(effectsBeforePendingStaleResume);

    const replayAtGateB = await runCompiledWorkflow({
      ...common,
      invocation: {},
      config: {},
      run: {
        run_id: runId,
        workflow_id: workflow.id,
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      }
    });
    expect(replayAtGateB).toMatchObject({
      status: "waiting_for_input",
      interrupt_id: atGateB.interrupt_id,
      checkpoint_id: atGateB.checkpoint_id,
      state: {
        interrupt_refs: [
          expect.objectContaining({ node_id: "gate_a" }),
          expect.objectContaining({ node_id: "gate_b" })
        ]
      }
    });
    expect(executeEffect).toHaveBeenCalledTimes(2);
    expect(publishArtifact).toHaveBeenCalledTimes(1);

    const terminalBarrierFailure = new RuntimeDurabilityRecoveryRequiredError(
      "control-plane terminal barrier unavailable"
    );
    await expect(resumeCompiledWorkflow({
      ...common,
      thread_id: runId,
      checkpoint_id: atGateB.checkpoint_id,
      interrupt_id: atGateB.interrupt_id,
      decision: { approved: true },
      onSucceededState: async () => {
        throw terminalBarrierFailure;
      }
    })).rejects.toBe(terminalBarrierFailure);
    expect(executions).toEqual(new Map([
      ["before_a", 1],
      ["between_gates", 1],
      ["after_b", 1]
    ]));
    await expect(stores.checkpoints.load(runId, {
      checkpointId: `terminal-${runId}-succeeded`,
      checkpointNs: ""
    })).resolves.toBeUndefined();
    await expect(stores.checkpoints.load(runId, {
      checkpointId: `terminal-${runId}-failed`,
      checkpointNs: ""
    })).resolves.toBeUndefined();

    const interruptsBeforeStale = await stores.interrupts.list(runId);
    const gateBBeforeStale = await stores.interrupts.get(atGateB.interrupt_id);
    const eventsBeforeStale = await stores.events.list(runId);
    await expect(resumeCompiledWorkflow({
      ...common,
      thread_id: runId,
      checkpoint_id: atGateA.checkpoint_id,
      interrupt_id: atGateA.interrupt_id,
      decision: { approved: true }
    })).rejects.toMatchObject({ code: "interrupt_stale" });

    expect(executeEffect).toHaveBeenCalledTimes(3);
    expect(executions).toEqual(new Map([
      ["before_a", 1],
      ["between_gates", 1],
      ["after_b", 1]
    ]));
    await expect(stores.interrupts.get(atGateB.interrupt_id))
      .resolves.toEqual(gateBBeforeStale);
    await expect(stores.interrupts.list(runId))
      .resolves.toEqual(interruptsBeforeStale);
    await expect(stores.events.list(runId)).resolves.toEqual(eventsBeforeStale);
    await expect(stores.checkpoints.load(runId, {
      checkpointId: `terminal-${runId}-succeeded`,
      checkpointNs: ""
    })).resolves.toBeUndefined();
    await expect(stores.checkpoints.load(runId, {
      checkpointId: `terminal-${runId}-failed`,
      checkpointNs: ""
    })).resolves.toBeUndefined();

    const completed = await resumeCompiledWorkflow({
      ...common,
      thread_id: runId,
      checkpoint_id: atGateB.checkpoint_id,
      interrupt_id: atGateB.interrupt_id,
      decision: { approved: true }
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      output: { node_id: "after_b", execution: 1 },
      state: {
        interrupt_refs: [
          {
            id: `interrupt-${runId}-gate_a`,
            uri: `interrupt://${runId}/gate_a`,
            node_id: "gate_a"
          },
          {
            id: `interrupt-${runId}-gate_b`,
            uri: `interrupt://${runId}/gate_b`,
            node_id: "gate_b"
          }
        ]
      }
    });
    expect(executeEffect).toHaveBeenCalledTimes(3);
    expect(publishArtifact).toHaveBeenCalledTimes(1);
    await expect(stores.checkpoints.load(runId, {
      checkpointId: `terminal-${runId}-succeeded`,
      checkpointNs: ""
    })).resolves.toMatchObject({
      state: {
        run_status: "succeeded",
        interrupt_refs: [
          expect.objectContaining({ node_id: "gate_a" }),
          expect.objectContaining({ node_id: "gate_b" })
        ]
      }
    });
  });
});
