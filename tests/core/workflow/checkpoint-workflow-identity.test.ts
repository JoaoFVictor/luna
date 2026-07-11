import { describe, expect, it } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import type {
  CheckpointRecord,
  CheckpointStore,
  SaveCheckpointInput
} from "../../../src/core/runtime/backends/contracts.js";
import type { JsonObject, JsonValue } from "../../../src/core/runtime/json.js";
import type { RunHandle } from "../../../src/core/runtime/run-handle.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";
import { RuntimeDurabilityRecoveryRequiredError } from "../../../src/core/runtime/errors.js";
import {
  resumeCompiledWorkflow,
  runCompiledWorkflow
} from "../../../src/runtime/langgraph/workflow-runner.js";
import { nodeOutputCheckpointId } from "../../../src/runtime/workflow/checkpoints.js";

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "identity-test",
    kind: "execution",
    version: "1.0.0",
    built_ins: {
      "identity-test.effect": {
        id: "identity-test.effect",
        input_schema: { type: "object" },
        output_schema: {
          type: "object",
          additionalProperties: false,
          required: ["revision"],
          properties: { revision: { type: "string" } }
        },
        required_ports: []
      }
    },
    gates: {
      "identity-test.approval": {
        id: "identity-test.approval",
        input_schema: { type: "object" },
        decision_schema: {
          type: "object",
          additionalProperties: false,
          required: ["approved"],
          properties: { approved: { type: "boolean" } }
        },
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

function workflow(revision: string): WorkflowDefinition {
  return {
    id: "checkpoint-workflow-identity",
    type: "workflow",
    mode: "read_only",
    directory: "/tmp/checkpoint-workflow-identity",
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    input_schema_content: { type: "object" },
    output_schema_content: {
      type: "object",
      additionalProperties: false,
      required: ["revision"],
      properties: { revision: { type: "string" } }
    },
    capabilities: ["identity-test"],
    graph: {
      nodes: [
        {
          id: "effect",
          type: "built_in",
          uses: "identity-test.effect"
        }
      ]
    },
    revision,
    external_definition_digests: {},
    execution: { max_concurrency: 1 },
    requires: { repository: false },
    observability: {
      exporters: { runtime_log: { enabled: true, required: false } }
    },
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

function waitingWorkflow(revision: string): WorkflowDefinition {
  return {
    ...workflow(revision),
    output_schema_content: {
      type: "object",
      additionalProperties: false,
      required: ["approved"],
      properties: { approved: { type: "boolean" } }
    },
    graph: {
      nodes: [
        {
          id: "approval",
          type: "human_gate",
          uses: "identity-test.approval"
        }
      ]
    }
  };
}

function partiallyRecoverableWorkflow(revision: string): WorkflowDefinition {
  return {
    ...workflow(revision),
    graph: {
      nodes: [
        {
          id: "first",
          type: "built_in",
          uses: "identity-test.effect"
        },
        {
          id: "second",
          type: "built_in",
          uses: "identity-test.effect",
          after: ["first"]
        }
      ]
    }
  };
}

function legacyMultiGateWorkflow(revision: string): WorkflowDefinition {
  return {
    ...workflow(revision),
    graph: {
      nodes: [
        {
          id: "gate_a",
          type: "human_gate",
          uses: "identity-test.approval"
        },
        {
          id: "between_gates",
          type: "built_in",
          uses: "identity-test.effect",
          after: ["gate_a"]
        },
        {
          id: "gate_b",
          type: "human_gate",
          uses: "identity-test.approval",
          after: ["between_gates"]
        }
      ]
    }
  };
}

function transientCheckpointRecord(
  input: SaveCheckpointInput
): CheckpointRecord {
  const createdAt = input.created_at ?? "2026-07-10T00:00:00.000Z";
  return {
    thread_id: input.thread_id,
    checkpoint_id: input.checkpoint_id,
    checkpoint_ns: input.checkpoint_ns ?? "",
    state_schema_version: input.state_schema_version,
    state: input.state,
    checkpoint: input.checkpoint ?? {
      v: 4,
      ts: createdAt,
      channel_versions: {},
      versions_seen: {}
    },
    metadata: input.metadata ?? {},
    ...(input.parent_config === undefined
      ? {}
      : { parent_config: input.parent_config }),
    created_at: createdAt,
    revision: 1
  };
}

function legacyCheckpointStore(delegate: CheckpointStore): CheckpointStore {
  return {
    save: async (input) =>
      input.checkpoint_id.startsWith("workflow-execution-identity-")
        ? transientCheckpointRecord(input)
        : await delegate.save(input),
    load: async (threadId, options) => await delegate.load(threadId, options),
    list: async (threadId, options) => await delegate.list(threadId, options),
    saveWrites: async (writes) => await delegate.saveWrites(writes),
    listWrites: async (threadId, checkpointNs, checkpointId) =>
      await delegate.listWrites(threadId, checkpointNs, checkpointId),
    hasThreadWrites: async (threadId) =>
      await delegate.hasThreadWrites(threadId),
    deleteThread: async (threadId) => await delegate.deleteThread(threadId)
  };
}

function checkpointStoreWithTamperedWaitIntent(
  delegate: CheckpointStore
): CheckpointStore {
  return {
    ...delegate,
    async listWrites(threadId, checkpointNs, checkpointId) {
      return (await delegate.listWrites(threadId, checkpointNs, checkpointId))
        .map((write) => {
          if (write.channel !== "interrupt_wait_intent") {
            return write;
          }
          const value = write.value as JsonObject;
          const resumeContext = value.resume_context as JsonObject;
          return {
            ...write,
            value: {
              ...value,
              resume_context: {
                ...resumeContext,
                config: { tampered_after_wait: true }
              }
            }
          };
        });
    }
  };
}

describe("workflow checkpoint execution identity", () => {
  it("rejects legacy gate A when a later pending gate proves newer progress", async () => {
    const stores = backends();
    const runId = "run-legacy-later-pending-gate";
    const definition = legacyMultiGateWorkflow("legacy-multi-gate-revision");
    const compiled = compileWorkflow({ workflow: definition, registry });
    const run = {
      run_id: runId,
      workflow_id: definition.id,
      attempt: 1,
      started_at: "2026-07-10T00:00:00.000Z"
    };
    const gateACheckpointId = `checkpoint-${runId}-gate_a`;
    await stores.checkpoints.save({
      thread_id: runId,
      checkpoint_id: gateACheckpointId,
      checkpoint_ns: "",
      state_schema_version: compiled.state_schema_version,
      state: {
        state_schema_version: compiled.state_schema_version,
        run_status: "waiting_for_input",
        artifact_refs: [],
        interrupt_refs: []
      },
      metadata: {
        workflow_revision: definition.revision,
        resume_node_id: "gate_a",
        resume_context: { invocation: {}, config: {}, run }
      }
    });
    await stores.checkpoints.saveWrites([{
      thread_id: runId,
      checkpoint_ns: "",
      checkpoint_id: `node-output-${runId}-between_gates`,
      task_id: "between_gates",
      index: 0,
      channel: "steps",
      value: { revision: "legacy-side-effect-output" }
    }]);
    await Promise.all([
      stores.interrupts.create({
        id: `interrupt-${runId}-gate_a`,
        run_id: runId,
        thread_id: runId,
        checkpoint_id: gateACheckpointId,
        node_id: "gate_a",
        status: "resolved",
        created_at: "2026-07-10T00:00:01.000Z",
        updated_at: "2026-07-10T00:00:02.000Z"
      }),
      stores.interrupts.create({
        id: `interrupt-${runId}-gate_b`,
        run_id: runId,
        thread_id: runId,
        checkpoint_id: `checkpoint-${runId}-gate_b`,
        node_id: "gate_b",
        status: "pending",
        created_at: "2026-07-10T00:00:03.000Z",
        updated_at: "2026-07-10T00:00:03.000Z"
      })
    ]);
    let executions = 0;

    await expect(resumeCompiledWorkflow({
      compiled,
      workflow: definition,
      checkpoint_id: gateACheckpointId,
      thread_id: runId,
      interrupt_id: `interrupt-${runId}-gate_a`,
      decision: { approved: true },
      backends: stores,
      builtIns: {
        "identity-test.effect": async () => {
          executions += 1;
          return { revision: "replayed" };
        }
      },
      agentRuntime: {} as AgentRuntimePort
    })).rejects.toMatchObject({
      code: "interrupt_stale",
      details: { later_interrupt_id: `interrupt-${runId}-gate_b` }
    });
    expect(executions).toBe(0);
    await expect(stores.checkpoints.load(runId, {
      checkpointId: `workflow-execution-identity-v2-${runId}`,
      checkpointNs: ""
    })).resolves.toBeUndefined();
  });

  it("fails closed for a legacy orphan output write without an identity row", async () => {
    const stores = backends();
    const runId = "run-legacy-orphan-output";
    const definition = workflow("legacy-output-revision");
    const compiled = compileWorkflow({ workflow: definition, registry });
    await stores.checkpoints.saveWrites([{
      thread_id: runId,
      checkpoint_ns: "",
      checkpoint_id: `node-output-${runId}-effect`,
      task_id: "effect",
      index: 0,
      channel: "steps",
      value: { revision: "legacy" }
    }]);
    let executions = 0;

    await expect(runCompiledWorkflow({
      compiled,
      workflow: definition,
      invocation: { request: "new" },
      config: {},
      run: {
        run_id: runId,
        workflow_id: definition.id,
        attempt: 1,
        started_at: "2026-07-10T00:00:00.000Z"
      },
      backends: stores,
      builtIns: {
        "identity-test.effect": async () => {
          executions += 1;
          return { revision: "new" };
        }
      },
      agentRuntime: {} as AgentRuntimePort
    })).rejects.toMatchObject({
      code: "runtime_checkpoint_schema_mismatch",
      details: { reason: "execution_identity_missing" }
    });
    expect(executions).toBe(0);
  });

  it("finds a legacy output from a removed node before executing its renamed replacement", async () => {
    const stores = backends();
    const runId = "run-legacy-renamed-effect";
    const definition: WorkflowDefinition = {
      ...workflow("renamed-effect-revision"),
      graph: {
        nodes: [{
          id: "renamed_effect",
          type: "built_in",
          uses: "identity-test.effect"
        }]
      }
    };
    const compiled = compileWorkflow({ workflow: definition, registry });
    await stores.checkpoints.saveWrites([{
      thread_id: runId,
      checkpoint_ns: "legacy-effects",
      checkpoint_id: `node-output-${runId}-old_effect`,
      task_id: "old_effect",
      index: 0,
      channel: "steps",
      value: { revision: "old-effect-committed" }
    }]);
    let executions = 0;

    await expect(runCompiledWorkflow({
      compiled,
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: runId,
        workflow_id: definition.id,
        attempt: 1,
        started_at: "2026-07-10T00:00:00.000Z"
      },
      backends: stores,
      builtIns: {
        "identity-test.effect": async () => {
          executions += 1;
          return { revision: "renamed-effect-replayed" };
        }
      },
      agentRuntime: {} as AgentRuntimePort
    })).rejects.toMatchObject({
      code: "runtime_checkpoint_schema_mismatch",
      details: { reason: "execution_identity_missing" }
    });
    expect(executions).toBe(0);
  });

  it("binds a run id to one revision and rejects every replay after terminal success", async () => {
    const stores = backends();
    const runId = "run-checkpoint-workflow-identity";
    const revisionA = workflow("revision-a");
    const compiledA = compileWorkflow({ workflow: revisionA, registry });
    let revisionAExecutions = 0;
    const inputA = {
      compiled: compiledA,
      workflow: revisionA,
      invocation: {},
      config: {},
      run: {
        run_id: runId,
        workflow_id: revisionA.id,
        attempt: 1,
        started_at: "2026-07-10T00:00:00.000Z"
      },
      backends: stores,
      builtIns: {
        "identity-test.effect": async () => {
          revisionAExecutions += 1;
          return { revision: "a" };
        }
      },
      agentRuntime: {} as AgentRuntimePort
    };

    await expect(runCompiledWorkflow(inputA)).resolves.toMatchObject({
      status: "succeeded",
      output: { revision: "a" }
    });
    await expect(runCompiledWorkflow(inputA)).rejects.toMatchObject({
      code: "runtime_state_invalid",
      details: { run_status: "succeeded" }
    });
    expect(revisionAExecutions).toBe(1);

    const revisionB = workflow("revision-b");
    const compiledB = compileWorkflow({ workflow: revisionB, registry });
    expect(nodeOutputCheckpointId(
      runId,
      compiledA.workflow_id,
      compiledA.workflow_revision,
      "effect"
    )).not.toBe(nodeOutputCheckpointId(
      runId,
      compiledB.workflow_id,
      compiledB.workflow_revision,
      "effect"
    ));

    let revisionBExecutions = 0;
    await expect(runCompiledWorkflow({
      ...inputA,
      compiled: compiledB,
      workflow: revisionB,
      builtIns: {
        "identity-test.effect": async () => {
          revisionBExecutions += 1;
          return { revision: "b" };
        }
      }
    })).rejects.toMatchObject({
      code: "runtime_checkpoint_schema_mismatch"
    });
    expect(revisionBExecutions).toBe(0);
  });

  it("does not let an invalid changed-revision resume poison a legacy waiting run", async () => {
    const stores = backends();
    const runId = "run-legacy-resume-identity";
    const revisionA = waitingWorkflow("legacy-revision-a");
    const compiledA = compileWorkflow({ workflow: revisionA, registry });
    const waiting = await runCompiledWorkflow({
      compiled: compiledA,
      workflow: revisionA,
      invocation: {},
      config: {},
      run: {
        run_id: runId,
        workflow_id: revisionA.id,
        attempt: 1,
        started_at: "2026-07-10T00:00:00.000Z"
      },
      backends: {
        ...stores,
        checkpoints: legacyCheckpointStore(stores.checkpoints)
      },
      builtIns: {},
      agentRuntime: {} as AgentRuntimePort
    });
    expect(waiting.status).toBe("waiting_for_input");
    if (waiting.status !== "waiting_for_input") {
      throw new Error("Expected the legacy workflow to wait for input");
    }
    const identityCheckpointId = `workflow-execution-identity-v2-${runId}`;
    await expect(stores.checkpoints.load(runId, {
      checkpointId: identityCheckpointId,
      checkpointNs: ""
    })).resolves.toBeUndefined();

    const revisionB = waitingWorkflow("changed-revision-b");
    await expect(resumeCompiledWorkflow({
      compiled: compileWorkflow({ workflow: revisionB, registry }),
      workflow: revisionB,
      checkpoint_id: waiting.checkpoint_id,
      thread_id: runId,
      interrupt_id: waiting.interrupt_id,
      decision: { approved: true },
      backends: stores,
      builtIns: {},
      agentRuntime: {} as AgentRuntimePort
    })).rejects.toMatchObject({ code: "runtime_checkpoint_schema_mismatch" });
    await expect(stores.checkpoints.load(runId, {
      checkpointId: identityCheckpointId,
      checkpointNs: ""
    })).resolves.toBeUndefined();

    await expect(resumeCompiledWorkflow({
      compiled: compiledA,
      workflow: revisionA,
      checkpoint_id: waiting.checkpoint_id,
      thread_id: runId,
      interrupt_id: waiting.interrupt_id,
      decision: { approved: true },
      backends: stores,
      builtIns: {},
      agentRuntime: {} as AgentRuntimePort
    })).resolves.toMatchObject({
      status: "succeeded",
      output: { approved: true }
    });
    await expect(stores.checkpoints.load(runId, {
      checkpointId: identityCheckpointId,
      checkpointNs: ""
    })).resolves.toMatchObject({
      metadata: {
        source: "workflow_execution_identity",
        identity_schema_version: 2,
        workflow_id: revisionA.id,
        workflow_revision: revisionA.revision,
        invocation_digest: expect.stringMatching(/^sha256:/),
        config_digest: expect.stringMatching(/^sha256:/),
        run_handle_digest: expect.stringMatching(/^sha256:/)
      }
    });
  });

  it("does not create an identity from a legacy wait intent whose resume context was altered", async () => {
    const stores = backends();
    const runId = "run-legacy-tampered-wait-intent";
    const definition = waitingWorkflow("legacy-tampered-intent-revision");
    const compiled = compileWorkflow({ workflow: definition, registry });
    const waiting = await runCompiledWorkflow({
      compiled,
      workflow: definition,
      invocation: { request: "original" },
      config: { profile: "original" },
      run: {
        run_id: runId,
        workflow_id: definition.id,
        attempt: 1,
        started_at: "2026-07-10T00:00:00.000Z"
      },
      backends: {
        ...stores,
        checkpoints: legacyCheckpointStore(stores.checkpoints)
      },
      builtIns: {},
      agentRuntime: {} as AgentRuntimePort
    });
    expect(waiting.status).toBe("waiting_for_input");
    if (waiting.status !== "waiting_for_input") {
      throw new Error("Expected the legacy workflow to wait for input");
    }

    await expect(resumeCompiledWorkflow({
      compiled,
      workflow: definition,
      checkpoint_id: waiting.checkpoint_id,
      thread_id: runId,
      interrupt_id: waiting.interrupt_id,
      decision: { approved: true },
      backends: {
        ...stores,
        checkpoints: checkpointStoreWithTamperedWaitIntent(stores.checkpoints)
      },
      builtIns: {},
      agentRuntime: {} as AgentRuntimePort
    })).rejects.toMatchObject({
      code: "runtime_checkpoint_schema_mismatch",
      details: { reason: "wait_intent_conflict" }
    });
    await expect(stores.checkpoints.load(runId, {
      checkpointId: `workflow-execution-identity-v2-${runId}`,
      checkpointNs: ""
    })).resolves.toBeUndefined();
    await expect(stores.interrupts.get(waiting.interrupt_id)).resolves.toMatchObject({
      status: "pending"
    });
  });

  it.each([
    {
      label: "invocation",
      mutate: (input: IdentityInputs): IdentityInputs => ({
        ...input,
        invocation: { request: "changed" }
      })
    },
    {
      label: "config",
      mutate: (input: IdentityInputs): IdentityInputs => ({
        ...input,
        config: { profile: "changed" }
      })
    },
    {
      label: "complete run handle",
      mutate: (input: IdentityInputs): IdentityInputs => ({
        ...input,
        run: { ...input.run, source: "changed-source" }
      })
    }
  ])("rejects changed $label before adopting partial node output", async ({ label, mutate }) => {
    const stores = backends();
    const definition = partiallyRecoverableWorkflow("bound-inputs-v2");
    const compiled = compileWorkflow({ workflow: definition, registry });
    const runId = `run-bound-inputs-${label.replaceAll(" ", "-")}`;
    const immutableInputs: IdentityInputs = {
      invocation: { request: "original" },
      config: { profile: "original" },
      run: {
        run_id: runId,
        workflow_id: definition.id,
        attempt: 1,
        started_at: "2026-07-10T00:00:00.000Z",
        source: "original-source"
      }
    };
    let originalExecutions = 0;
    await expect(runCompiledWorkflow({
      compiled,
      workflow: definition,
      ...immutableInputs,
      backends: stores,
      builtIns: {
        "identity-test.effect": async ({ node }) => {
          originalExecutions += 1;
          if (node.id === "second") {
            throw new RuntimeDurabilityRecoveryRequiredError(
              "simulated checkpoint reconciliation"
            );
          }
          return { revision: "first" };
        }
      },
      agentRuntime: {} as AgentRuntimePort
    })).rejects.toBeInstanceOf(RuntimeDurabilityRecoveryRequiredError);
    expect(originalExecutions).toBe(2);

    let retryExecutions = 0;
    await expect(runCompiledWorkflow({
      compiled,
      workflow: definition,
      ...mutate(immutableInputs),
      backends: stores,
      builtIns: {
        "identity-test.effect": async () => {
          retryExecutions += 1;
          return { revision: "retry" };
        }
      },
      agentRuntime: {} as AgentRuntimePort
    })).rejects.toMatchObject({
      code: "runtime_checkpoint_schema_mismatch"
    });
    expect(retryExecutions).toBe(0);
  });
});

type IdentityInputs = {
  readonly invocation: JsonValue;
  readonly config: JsonValue;
  readonly run: RunHandle;
};
