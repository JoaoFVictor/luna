import { describe, expect, it } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type { InterruptStore } from "../../../src/core/runtime/interrupts/contracts.js";
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

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "runtime",
    kind: "execution",
    version: "1.0.0",
    built_ins: Object.fromEntries(
      ["runtime.pre", "runtime.after"].map((id) => [
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
  id: "concurrent-resume",
  type: "workflow",
  mode: "read_only",
  directory: "/tmp/concurrent-resume",
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
        id: "after",
        type: "built_in",
        uses: "runtime.after",
        after: ["approve"],
        artifacts: [
          {
            path: "after.json",
            publisher: "artifacts.manifest_publisher",
            source: { expression: "$.steps.after" },
            format: "json",
            required: true
          }
        ]
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

describe("workflow resume lease", () => {
  it("serializes concurrent resumes and rejects the one that observes terminal success", async () => {
    const memoryInterrupts = createMemoryInterruptStore();
    const secondLeaseQueued = deferred();
    let leaseAttempts = 0;
    let leaseEntries = 0;
    const interrupts: InterruptStore = {
      ...memoryInterrupts,
      async withResumeLease(id, operation) {
        leaseAttempts += 1;
        if (leaseAttempts === 2) {
          secondLeaseQueued.resolve();
        }
        return await memoryInterrupts.withResumeLease(id, async () => {
          leaseEntries += 1;
          return await operation();
        });
      }
    };
    const stores = {
      artifacts: createMemoryArtifactManifestStore(),
      events: createMemoryEventStore(),
      interrupts,
      checkpoints: createMemoryCheckpointStore(),
      runtimeLogs: createMemoryRuntimeLogStore()
    };
    const compiled = compileWorkflow({ workflow, registry });
    const waiting = await runCompiledWorkflow({
      compiled,
      workflow,
      invocation: {},
      config: {},
      run: {
        run_id: "run-concurrent-resume",
        workflow_id: workflow.id,
        attempt: 1,
        started_at: "2026-07-11T00:00:00.000Z"
      },
      backends: stores,
      builtIns: { "runtime.pre": async () => ({ ready: true }) },
      agentRuntime: {} as AgentRuntimePort
    });
    if (waiting.status !== "waiting_for_input") {
      throw new Error("Expected workflow to wait for input.");
    }
    leaseAttempts = 0;
    leaseEntries = 0;

    const firstBarrierEntered = deferred();
    const releaseFirstBarrier = deferred();
    let executorCalls = 0;
    let publisherCalls = 0;
    let barrierCalls = 0;
    let activeBarriers = 0;
    let maxActiveBarriers = 0;
    const resumeInput = {
      compiled,
      workflow,
      checkpoint_id: waiting.checkpoint_id,
      thread_id: "run-concurrent-resume",
      interrupt_id: waiting.interrupt_id,
      decision: { approved: true },
      backends: stores,
      builtIns: {
        "runtime.after": async () => {
          executorCalls += 1;
          return { done: true };
        }
      },
      artifactPublisher: {
        async publish({ node_id, path }: { node_id: string; path: string }) {
          publisherCalls += 1;
          return { id: path, uri: `memory://${path}`, node_id };
        }
      },
      agentRuntime: {} as AgentRuntimePort,
      async onSucceededState() {
        barrierCalls += 1;
        activeBarriers += 1;
        maxActiveBarriers = Math.max(maxActiveBarriers, activeBarriers);
        if (barrierCalls === 1) {
          firstBarrierEntered.resolve();
          await releaseFirstBarrier.promise;
        }
        activeBarriers -= 1;
      }
    };

    const firstResume = resumeCompiledWorkflow(resumeInput);
    await firstBarrierEntered.promise;
    const secondResume = resumeCompiledWorkflow(resumeInput).catch(
      (cause: unknown) => cause
    );
    await secondLeaseQueued.promise;

    try {
      expect(leaseEntries).toBe(1);
      expect(barrierCalls).toBe(1);
      expect(activeBarriers).toBe(1);
      expect(executorCalls).toBe(1);
      expect(publisherCalls).toBe(1);
    } finally {
      releaseFirstBarrier.resolve();
    }

    await expect(firstResume).resolves.toMatchObject({ status: "succeeded" });
    await expect(secondResume).resolves.toMatchObject({
      code: "runtime_state_invalid",
      details: { run_status: "succeeded" }
    });
    expect(leaseEntries).toBe(2);
    expect(barrierCalls).toBe(1);
    expect(maxActiveBarriers).toBe(1);
    expect(executorCalls).toBe(1);
    expect(publisherCalls).toBe(1);
  });
});
