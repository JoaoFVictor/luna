import { describe, expect, it } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import type { WorkflowArtifactPublisherPort } from "../../../src/core/workflow/execution-contracts.js";
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

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "runtime",
    kind: "execution",
    version: "1.0.0",
    built_ins: Object.fromEntries(
      ["runtime.pre", "runtime.effect", "runtime.report"].map((id) => [
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

function backends() {
  return {
    artifacts: createMemoryArtifactManifestStore(),
    events: createMemoryEventStore(),
    interrupts: createMemoryInterruptStore(),
    checkpoints: createMemoryCheckpointStore(),
    runtimeLogs: createMemoryRuntimeLogStore()
  };
}

function rejectFailedTerminalCheckpoint(
  stores: ReturnType<typeof backends>,
  runId: string
): void {
  const checkpointStore = stores.checkpoints;
  stores.checkpoints = {
    ...checkpointStore,
    async save(input) {
      if (input.checkpoint_id === `terminal-${runId}-failed`) {
        throw new Error("failed terminal checkpoint unavailable");
      }
      return await checkpointStore.save(input);
    }
  };
}

function workflow(
  id: string,
  downstreamNodes: WorkflowDefinition["graph"]["nodes"]
): WorkflowDefinition {
  return {
    id,
    type: "workflow",
    mode: "read_only",
    directory: `/tmp/${id}`,
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
        ...downstreamNodes
      ]
    },
    revision: "revision-1",
    external_definition_digests: {},
    execution: { max_concurrency: 1 },
    requires: { repository: false },
    observability: { exporters: { runtime_log: { enabled: true, required: false } } },
    subagent_policy: { allow_write: false }
  };
}

function artifactNode(id: string, after: string) {
  return {
    id,
    type: "built_in" as const,
    uses: "runtime.report",
    after: [after],
    artifacts: [
      {
        path: `${id}.json`,
        publisher: "artifacts.manifest_publisher",
        source: { expression: `$.steps.${id}` },
        format: "json" as const,
        required: true
      }
    ]
  };
}

async function createWaitingRun({
  definition,
  stores,
  runId,
  artifactPublisher
}: {
  readonly definition: WorkflowDefinition;
  readonly stores: ReturnType<typeof backends>;
  readonly runId: string;
  readonly artifactPublisher?: WorkflowArtifactPublisherPort;
}) {
  const compiled = compileWorkflow({ workflow: definition, registry });
  const waiting = await runCompiledWorkflow({
    compiled,
    workflow: definition,
    invocation: {},
    config: {},
    run: {
      run_id: runId,
      workflow_id: definition.id,
      attempt: 1,
      started_at: "2026-06-25T00:00:00.000Z"
    },
    backends: stores,
    builtIns: { "runtime.pre": async () => ({ ready: true }) },
    ...(artifactPublisher === undefined ? {} : { artifactPublisher }),
    agentRuntime: {} as AgentRuntimePort
  });
  if (waiting.status !== "waiting_for_input") {
    throw new Error("expected workflow to wait for input");
  }
  return { compiled, waiting };
}

function failArtifactOnce(): {
  readonly publisher: WorkflowArtifactPublisherPort;
  readonly attempts: () => number;
} {
  let attempts = 0;
  return {
    publisher: {
      async publish({ node_id, path }) {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("required artifact failed once");
        }
        return { id: path, uri: `memory://${path}`, node_id };
      }
    },
    attempts: () => attempts
  };
}

describe("workflow resume node completion markers", () => {
  it("retries a required downstream artifact without reexecuting its persisted output", async () => {
    const definition = workflow(
      "resume-downstream-artifact",
      [artifactNode("report", "approve")]
    );
    const stores = backends();
    rejectFailedTerminalCheckpoint(stores, "run-resume-downstream-artifact");
    const { compiled, waiting } = await createWaitingRun({
      definition,
      stores,
      runId: "run-resume-downstream-artifact"
    });
    const artifact = failArtifactOnce();
    let reportExecutions = 0;
    const resumeInput = {
      compiled,
      workflow: definition,
      checkpoint_id: waiting.checkpoint_id,
      thread_id: "run-resume-downstream-artifact",
      interrupt_id: waiting.interrupt_id,
      decision: { approved: true },
      backends: stores,
      builtIns: {
        "runtime.report": async () => {
          reportExecutions += 1;
          return { report: true };
        }
      },
      artifactPublisher: artifact.publisher,
      agentRuntime: {} as AgentRuntimePort
    };

    await expect(resumeCompiledWorkflow(resumeInput)).rejects.toMatchObject({
      code: "runtime_durability_recovery_required"
    });
    expect(reportExecutions).toBe(1);
    expect(artifact.attempts()).toBe(1);

    const resumed = await resumeCompiledWorkflow(resumeInput);
    expect(resumed).toMatchObject({
      status: "succeeded",
      state: {
        artifact_refs: [
          {
            id: "report.json",
            uri: "memory://report.json",
            node_id: "report"
          }
        ]
      }
    });
    expect(reportExecutions).toBe(1);
    expect(artifact.attempts()).toBe(2);
    await expect(stores.checkpoints.load(
      resumeInput.thread_id,
      { checkpointId: `terminal-${resumeInput.thread_id}-succeeded` }
    )).resolves.toMatchObject({
      state: {
        run_status: "succeeded",
        artifact_refs: [expect.objectContaining({ id: "report.json" })]
      }
    });
  });

  it("skips a completed side-effect node while recovering a later artifact batch", async () => {
    const definition = workflow(
      "resume-completed-side-effect",
      [
        {
          id: "effect",
          type: "built_in",
          uses: "runtime.effect",
          after: ["approve"]
        },
        artifactNode("report", "effect")
      ]
    );
    const stores = backends();
    rejectFailedTerminalCheckpoint(stores, "run-resume-completed-side-effect");
    const { compiled, waiting } = await createWaitingRun({
      definition,
      stores,
      runId: "run-resume-completed-side-effect"
    });
    const artifact = failArtifactOnce();
    let effectExecutions = 0;
    let reportExecutions = 0;
    const resumeInput = {
      compiled,
      workflow: definition,
      checkpoint_id: waiting.checkpoint_id,
      thread_id: "run-resume-completed-side-effect",
      interrupt_id: waiting.interrupt_id,
      decision: { approved: true },
      backends: stores,
      builtIns: {
        "runtime.effect": async () => {
          effectExecutions += 1;
          return { applied: true };
        },
        "runtime.report": async () => {
          reportExecutions += 1;
          return { report: true };
        }
      },
      artifactPublisher: artifact.publisher,
      agentRuntime: {} as AgentRuntimePort
    };

    await expect(resumeCompiledWorkflow(resumeInput)).rejects.toMatchObject({
      code: "runtime_durability_recovery_required"
    });
    expect(effectExecutions).toBe(1);
    expect(reportExecutions).toBe(1);

    await expect(resumeCompiledWorkflow(resumeInput)).resolves.toMatchObject({
      status: "succeeded",
      state: {
        steps: {
          effect: { applied: true },
          report: { report: true }
        }
      }
    });
    expect(effectExecutions).toBe(1);
    expect(reportExecutions).toBe(1);
    expect(artifact.attempts()).toBe(2);
  });

  it("does not revive a run after an exact failed terminal checkpoint", async () => {
    const definition = workflow(
      "resume-terminal-failed",
      [artifactNode("report", "approve")]
    );
    const stores = backends();
    const { compiled, waiting } = await createWaitingRun({
      definition,
      stores,
      runId: "run-resume-terminal-failed"
    });
    const artifact = failArtifactOnce();
    let reportExecutions = 0;
    const resumeInput = {
      compiled,
      workflow: definition,
      checkpoint_id: waiting.checkpoint_id,
      thread_id: "run-resume-terminal-failed",
      interrupt_id: waiting.interrupt_id,
      decision: { approved: true },
      backends: stores,
      builtIns: {
        "runtime.report": async () => {
          reportExecutions += 1;
          return { report: true };
        }
      },
      artifactPublisher: artifact.publisher,
      agentRuntime: {} as AgentRuntimePort
    };

    await expect(resumeCompiledWorkflow(resumeInput)).rejects.toThrow(
      "required artifact failed once"
    );
    await expect(stores.checkpoints.load(
      resumeInput.thread_id,
      { checkpointId: `terminal-${resumeInput.thread_id}-failed` }
    )).resolves.toMatchObject({ state: { run_status: "failed" } });

    await expect(resumeCompiledWorkflow(resumeInput)).rejects.toMatchObject({
      code: "runtime_state_invalid"
    });
    expect(reportExecutions).toBe(1);
    expect(artifact.attempts()).toBe(1);
  });

  it("rehydrates pre-gate artifacts exactly once from durable completion state", async () => {
    const base = workflow(
      "resume-pre-gate-artifact",
      [
        {
          id: "report",
          type: "built_in",
          uses: "runtime.report",
          after: ["approve"]
        }
      ]
    );
    const definition: WorkflowDefinition = {
      ...base,
      graph: {
        nodes: base.graph.nodes.map((node) =>
          node.id !== "pre"
            ? node
            : {
                ...node,
                artifacts: [
                  {
                    path: "pre.json",
                    publisher: "artifacts.manifest_publisher",
                    source: { expression: "$.steps.pre" },
                    format: "json",
                    required: true
                  }
                ]
              }
        )
      }
    };
    const stores = backends();
    const publisher: WorkflowArtifactPublisherPort = {
      async publish({ node_id, path }) {
        return { id: path, uri: `memory://${path}`, node_id };
      }
    };
    const { compiled, waiting } = await createWaitingRun({
      definition,
      stores,
      runId: "run-resume-pre-gate-artifact",
      artifactPublisher: publisher
    });
    expect(waiting.state.artifact_refs).toEqual([
      {
        id: "pre.json",
        uri: "memory://pre.json",
        node_id: "pre"
      }
    ]);

    const resumed = await resumeCompiledWorkflow({
      compiled,
      workflow: definition,
      checkpoint_id: waiting.checkpoint_id,
      thread_id: "run-resume-pre-gate-artifact",
      interrupt_id: waiting.interrupt_id,
      decision: { approved: true },
      backends: stores,
      builtIns: {
        "runtime.report": async () => ({ report: true })
      },
      artifactPublisher: publisher,
      agentRuntime: {} as AgentRuntimePort
    });

    expect(resumed).toMatchObject({
      status: "succeeded",
      state: {
        artifact_refs: [
          {
            id: "pre.json",
            uri: "memory://pre.json",
            node_id: "pre"
          }
        ]
      }
    });
  });
});
