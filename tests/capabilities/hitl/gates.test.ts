import { describe, expect, it, vi } from "vitest";
import { manifest as hitlManifest } from "../../../src/capabilities/hitl/manifest.js";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
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

const protectedEffectManifest = capabilityManifest({
  id: "protected-effect",
  kind: "execution",
  version: "1",
  built_ins: {
    "protected-effect.publish": {
      id: "protected-effect.publish",
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      required_ports: [],
      side_effect_policy: "protected-effect.publish_side_effect"
    }
  },
  policies: {
    "protected-effect.publish_side_effect": {
      id: "protected-effect.publish_side_effect",
      config_schema: { type: "object" },
      side_effect_semantics: "write",
      side_effect_operation_ids: ["protected-effect.publish"],
      idempotency_scope: "run",
      retry_semantics: "retry_requires_adoption"
    }
  }
});

const registry = createCapabilityRegistry([
  hitlManifest,
  protectedEffectManifest
]);

const approvalWorkflow: WorkflowDefinition = {
  id: "strict-approval-contract",
  type: "workflow",
  mode: "read_only",
  directory: "/tmp/strict-approval-contract",
  input_schema: "input.json",
  output_schema: "output.json",
  input_schema_content: { type: "object" },
  output_schema_content: { type: "object" },
  capabilities: ["hitl", "protected-effect"],
  graph: {
    nodes: [
      {
        id: "approval",
        type: "human_gate",
        uses: "hitl.approval",
        input: { prompt: "Approve the protected effect" }
      },
      {
        id: "publish",
        type: "built_in",
        uses: "protected-effect.publish",
        policies: [{
          uses: "protected-effect.publish_side_effect",
          config: { operation_id: "protected-effect.publish" }
        }],
        after: ["approval"]
      }
    ]
  },
  revision: "strict-approval-contract-v1",
  external_definition_digests: {},
  execution: { max_concurrency: 1 },
  requires: { repository: false },
  observability: {
    exporters: { runtime_log: { enabled: false, required: false } }
  },
  subagent_policy: { allow_write: false }
};

const agentRuntime: AgentRuntimePort = {
  describe: () => ({
    id: "unused",
    display_name: "Unused agent runtime",
    supported_runtime_requirements: [],
    supported_tool_protocols: []
  }),
  validate: () => undefined,
  runAgent: async () => {
    throw new Error("Agent runtime is not used by this workflow");
  }
};

function backends() {
  return {
    artifacts: createMemoryArtifactManifestStore(),
    checkpoints: createMemoryCheckpointStore(),
    events: createMemoryEventStore(),
    interrupts: createMemoryInterruptStore(),
    runtimeLogs: createMemoryRuntimeLogStore()
  };
}

describe("hitl gate contracts", () => {
  it("never treats request_changes as approval for a protected standalone gate", async () => {
    const publish = vi.fn(() => ({ published: true }));
    const compiled = compileWorkflow({ workflow: approvalWorkflow, registry });
    const common = {
      compiled,
      workflow: approvalWorkflow,
      backends: backends(),
      builtIns: { "protected-effect.publish": publish },
      agentRuntime
    };
    const waiting = await runCompiledWorkflow({
      ...common,
      invocation: {},
      config: {},
      run: {
        run_id: "strict-approval-run",
        workflow_id: approvalWorkflow.id,
        attempt: 1,
        started_at: "2026-07-12T00:00:00.000Z"
      }
    });
    expect(waiting.status).toBe("waiting_for_input");
    if (waiting.status !== "waiting_for_input") {
      throw new Error("Expected the approval interrupt");
    }

    await expect(resumeCompiledWorkflow({
      ...common,
      thread_id: "strict-approval-run",
      checkpoint_id: waiting.checkpoint_id,
      interrupt_id: waiting.interrupt_id,
      decision: {
        action: "request_changes",
        comment: "Change it first",
        targets: ["content"]
      }
    })).rejects.toMatchObject({
      code: "runtime_node_output_schema_invalid"
    });
    expect(publish).not.toHaveBeenCalled();

    const completed = await resumeCompiledWorkflow({
      ...common,
      thread_id: "strict-approval-run",
      checkpoint_id: waiting.checkpoint_id,
      interrupt_id: waiting.interrupt_id,
      decision: { action: "approve" }
    });

    expect(completed.status).toBe("succeeded");
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
