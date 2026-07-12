import { describe, expect, it } from "vitest";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type {
  WorkflowDefinition,
  WorkflowNode
} from "../../../src/core/workflow/definition-types.js";
import {
  compileWorkflow,
  type CompiledWorkflow
} from "../../../src/core/workflow/compiler.js";
import { validateNodesAgainstCapabilities } from "../../../src/core/workflow/definition-validation.js";

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "runtime",
    kind: "execution",
    version: "1.0.0",
    built_ins: {
      "runtime.preflight": {
        id: "runtime.preflight",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        required_ports: []
      },
      "runtime.write": {
        id: "runtime.write",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        required_ports: [],
        side_effect_policy: "runtime.write_policy"
      }
    },
    policies: {
      "runtime.write_policy": {
        id: "runtime.write_policy",
        config_schema: { type: "object" },
        side_effect_semantics: "write",
        side_effect_operation_ids: ["runtime.write"],
        idempotency_scope: "run",
        retry_semantics: "retry_requires_adoption"
      }
    }
  }),
  capabilityManifest({
    id: "agents",
    kind: "execution",
    version: "1.0.0",
    workflow_node_types: ["agent"],
    schemas: {
      "agents.review_output": {
        id: "agents.review_output",
        schema: { type: "object" }
      }
    }
  }),
  capabilityManifest({
    id: "quality",
    kind: "execution",
    version: "1.0.0",
    patterns: {
      "quality.gated_agent_loop": {
        id: "quality.gated_agent_loop",
        declaring_node_type: "pattern",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        expand: { type: "declaring_node_subgraph" },
        execution_policy: {
          batch_exclusion_keys: ["agent_session"]
        }
      }
    },
    gates: {
      "quality.approval": {
        id: "quality.approval",
        input_schema: { type: "object" },
        decision_schema: { type: "object" },
        output_schema: { type: "object" },
        interrupt: "required"
      }
    }
  })
]);

function workflow(nodes: WorkflowNode[]): WorkflowDefinition {
  return {
    id: "compiler-test",
    type: "workflow",
    mode: "trusted_local_write",
    directory: "/tmp/compiler-test",
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    input_schema_content: { type: "object" },
    output_schema_content: { type: "object" },
    capabilities: ["runtime", "agents", "quality"],
    graph: { nodes },
    revision: "revision-1",
    external_definition_digests: {},
    execution: { max_concurrency: 4 },
    requires: { repository: false },
    observability: { exporters: { runtime_log: { enabled: true, required: false } } },
    subagent_policy: { allow_write: true }
  };
}

function edgePairs(compiled: CompiledWorkflow): string[] {
  return compiled.edges.map((edge) => `${edge.from}->${edge.to}`);
}

describe("workflow compiler", () => {
  it.each([
    "__luna_wait_intent__:approve",
    "__luna_wait_completion__:approve",
    "__luna_resume_completion__:approve",
    "__start__",
    "__end__",
    "contains:colon",
    "contains|pipe",
    "state_schema_version",
    "invocation",
    "config",
    "run",
    "workflow",
    "run_status",
    "node_statuses",
    "steps",
    "attempts",
    "artifact_refs",
    "interrupt_refs",
    "event_cursor",
    "primary_failure"
  ])("rejects runtime-reserved workflow node id %s", (nodeId) => {
    const nodes: WorkflowNode[] = [{
      id: nodeId,
      type: "built_in",
      uses: "runtime.preflight"
    }];

    expect(() => validateNodesAgainstCapabilities(
      nodes,
      ["runtime"],
      new Set([nodeId]),
      registry
    )).toThrow(expect.objectContaining({
      code: "workflow_node_id_reserved",
      path: "$.nodes[0].id"
    }));
    expect(() => compileWorkflow({ workflow: workflow(nodes), registry }))
      .toThrow(expect.objectContaining({
        code: "workflow_node_id_reserved",
        path: "$.nodes[0].id"
      }));
  });

  it("derives an agent node capability from the registry semantic role", () => {
    const modelRegistry = createCapabilityRegistry([
      capabilityManifest({
        id: "model-execution",
        kind: "execution",
        version: "1.0.0",
        workflow_node_types: ["agent"],
        schemas: {
          "model-execution.result": {
            id: "model-execution.result",
            schema: { type: "object" }
          }
        }
      })
    ]);
    const definition = workflow([{
      id: "review",
      type: "agent",
      agent: "reviewer",
      output_schema: "model-execution.result"
    }]);

    expect(compileWorkflow({ workflow: definition, registry: modelRegistry }).nodes[0])
      .toMatchObject({ kind: "agent", capability_id: "model-execution" });

    const parsedNode = {
      id: "review",
      type: "agent" as const,
      agent: "reviewer",
      output_schema: "model-execution.result"
    };
    expect(() => validateNodesAgainstCapabilities(
      [parsedNode],
      ["model-execution"],
      new Set([parsedNode.id]),
      modelRegistry
    )).not.toThrow();
    expect(() => validateNodesAgainstCapabilities(
      [parsedNode],
      [],
      new Set([parsedNode.id]),
      modelRegistry
    )).toThrow(expect.objectContaining({
      code: "workflow_capability_missing",
      capability: "model-execution"
    }));
  });

  it("copies pattern execution policy metadata from the capability registration", () => {
    const compiled = compileWorkflow({
      workflow: workflow([
        {
          id: "write_loop",
          type: "pattern",
          uses: "quality.gated_agent_loop",
          worker: "writer",
          gates: [{ id: "approval", type: "quality.approval" }]
        }
      ]),
      registry,
      reducers: { steps: "object_merge" }
    });

    expect(compiled.nodes[0]).toMatchObject({
      id: "write_loop",
      kind: "pattern",
      execution_policy: {
        batch_exclusion_keys: ["agent_session"]
      }
    });
  });

  it("compiles fan-out branches and requires a registered reducer before fan-in merge", () => {
    const fanInWorkflow = workflow([
      { id: "start", type: "built_in", uses: "runtime.preflight" },
      { id: "left", type: "built_in", uses: "runtime.preflight", after: ["start"] },
      { id: "right", type: "built_in", uses: "runtime.preflight", after: ["start"] },
      {
        id: "join",
        type: "built_in",
        uses: "runtime.preflight",
        after: ["left", "right"]
      }
    ]);

    expect(() =>
      compileWorkflow({ workflow: fanInWorkflow, registry })
    ).toThrowError(expect.objectContaining({ code: "workflow_parallel_merge_without_reducer" }));

  });

  it("rejects protected side effects that can run before approval", () => {
    expect(() =>
      compileWorkflow({
        workflow: workflow([
          { id: "approve", type: "human_gate", uses: "quality.approval" },
          {
            id: "write",
            type: "built_in",
            uses: "runtime.write",
            policies: [{ uses: "runtime.write_policy" }]
          }
        ]),
        registry
      })
    ).toThrowError(expect.objectContaining({ code: "workflow_protected_operation_before_approval" }));
  });

  it("rejects fan-out branches that could create multiple pending HITL interrupts", () => {
    expect(() =>
      compileWorkflow({
        workflow: workflow([
          { id: "left-root", type: "built_in", uses: "runtime.preflight" },
          { id: "right-root", type: "built_in", uses: "runtime.preflight" },
          {
            id: "approve-left",
            type: "human_gate",
            uses: "quality.approval",
            after: ["left-root"]
          },
          {
            id: "approve-right",
            type: "human_gate",
            uses: "quality.approval",
            after: ["right-root"]
          }
        ]),
        registry
      })
    ).toThrowError(expect.objectContaining({ code: "workflow_parallel_hitl_unsupported" }));
  });

  it.each(["gate-first", "sibling-first"] as const)(
    "rejects a pending HITL node parallel to an ordinary sibling (%s)",
    (order) => {
      const gate = {
        id: "approve",
        type: "human_gate" as const,
        uses: "quality.approval",
        after: ["start"]
      };
      const sibling = {
        id: "reader",
        type: "built_in" as const,
        uses: "runtime.preflight",
        after: ["start"]
      };

      expect(() =>
        compileWorkflow({
          workflow: workflow([
            { id: "start", type: "built_in", uses: "runtime.preflight" },
            ...(order === "gate-first" ? [gate, sibling] : [sibling, gate])
          ]),
          registry
        })
      ).toThrowError(expect.objectContaining({
        code: "workflow_parallel_hitl_unsupported"
      }));
    }
  );
});
