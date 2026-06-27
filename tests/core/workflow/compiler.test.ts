import { describe, expect, it } from "vitest";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type {
  WorkflowDefinition,
  WorkflowNode
} from "../../../src/core/workflow/definition-types.js";
import {
  LUNA_COMPILED_WORKFLOW_STATE_CHANNELS,
  compileWorkflow,
  type CompiledWorkflow
} from "../../../src/core/workflow/compiler.js";
import {
  LUNA_RUNTIME_STATE_CHANNELS,
  LUNA_RUNTIME_STATE_SCHEMA_VERSION
} from "../../../src/core/runtime/state.js";

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
    ports: {
      "agents.runtime": {
        id: "agents.runtime",
        capability: "agents",
        option_schema: { type: "object" }
      }
    },
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
        expand: { type: "declaring_node_subgraph" }
      }
    },
    gates: {
      "quality.approval": {
        id: "quality.approval",
        input_schema: { type: "object" },
        decision_schema: { type: "object" },
        output_schema: { type: "object" },
        interrupt: "required"
      },
      "quality.validation": {
        id: "quality.validation",
        input_schema: { type: "object" },
        decision_schema: { type: "object" },
        output_schema: { type: "object" },
        interrupt: "none"
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
  it("emits LangGraph-ready nodes and dependency edges from validated YAML nodes", () => {
    const compiled = compileWorkflow({
      workflow: workflow([
        { id: "preflight", type: "built_in", uses: "runtime.preflight" },
        {
          id: "review",
          type: "agent",
          agent: "reviewer",
          output_schema: "agents.review_output",
          after: ["preflight"]
        },
        {
          id: "report",
          type: "built_in",
          uses: "runtime.preflight",
          after: ["review"]
        }
      ]),
      registry
    });

    expect(compiled.nodes.map((node) => [node.id, node.kind])).toEqual([
      ["preflight", "built_in"],
      ["review", "agent"],
      ["report", "built_in"]
    ]);
    expect(edgePairs(compiled)).toEqual([
      "__start__->preflight",
      "preflight->review",
      "review->report",
      "report->__end__"
    ]);
    expect(compiled.state.channels).toMatchObject({
      node_statuses: { reducer: "object_merge" },
      steps: { reducer: "object_merge" },
      attempts: { reducer: "object_merge" },
      artifact_refs: { reducer: "append_only" },
      interrupt_refs: { reducer: "append_only" }
    });
    expect(compiled.state.channels).not.toHaveProperty("events");
    expect(compiled.state.channels).not.toHaveProperty("artifacts");
    expect(compiled.state.channels).not.toHaveProperty("interrupts");
    expect(compiled.state_schema_version).toBe(LUNA_RUNTIME_STATE_SCHEMA_VERSION);
    expect(compiled.state.channels).toEqual(LUNA_COMPILED_WORKFLOW_STATE_CHANNELS);
    expect(compiled.state.channels).toEqual(LUNA_RUNTIME_STATE_CHANNELS);
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

    const compiled = compileWorkflow({
      workflow: fanInWorkflow,
      registry,
      reducers: { steps: "object_merge" }
    });

    expect(edgePairs(compiled)).toContain("start->left");
    expect(edgePairs(compiled)).toContain("start->right");
    expect(edgePairs(compiled)).toContain("left->join");
    expect(edgePairs(compiled)).toContain("right->join");
  });

  it("does not require a reducer for redundant serial dependencies", () => {
    const compiled = compileWorkflow({
      workflow: workflow([
        { id: "a", type: "built_in", uses: "runtime.preflight" },
        { id: "b", type: "built_in", uses: "runtime.preflight", after: ["a"] },
        {
          id: "c",
          type: "built_in",
          uses: "runtime.preflight",
          after: ["a", "b"]
        }
      ]),
      registry
    });

    expect(edgePairs(compiled)).toContain("a->c");
    expect(edgePairs(compiled)).toContain("b->c");
  });

  it("rejects arbitrary LangGraph commands or unknown node types in YAML", () => {
    expect(() =>
      compileWorkflow({
        workflow: workflow([
          {
            id: "command",
            type: "langgraph_command",
            command: "goto"
          } as unknown as WorkflowNode
        ]),
        registry
      })
    ).toThrowError(expect.objectContaining({ code: "workflow_node_type_unsupported" }));
  });

  it("enforces capability namespaces and registered output schemas", () => {
    expect(() =>
      compileWorkflow({
        workflow: workflow([
          { id: "unknown", type: "built_in", uses: "missing.capability" }
        ]),
        registry
      })
    ).toThrowError(expect.objectContaining({ code: "workflow_capability_unknown" }));

    expect(() =>
      compileWorkflow({
        workflow: workflow([
          {
            id: "review",
            type: "agent",
            agent: "reviewer",
            output_schema: "agents.missing"
          }
        ]),
        registry
      })
    ).toThrowError(expect.objectContaining({ code: "workflow_capability_unknown" }));
  });

  it("inserts approval interrupt steps before protected side-effect nodes", () => {
    const compiled = compileWorkflow({
      workflow: workflow([
        { id: "approve", type: "human_gate", uses: "quality.approval" },
        {
          id: "write",
          type: "built_in",
          uses: "runtime.write",
          policies: [{ uses: "runtime.write_policy" }],
          after: ["approve"]
        }
      ]),
      registry
    });

    expect(compiled.nodes.map((node) => [node.id, node.kind])).toContainEqual([
      "approve",
      "interrupt"
    ]);
    expect(edgePairs(compiled)).toEqual([
      "__start__->approve",
      "approve->write",
      "write->__end__"
    ]);
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
          { id: "approve-left", type: "human_gate", uses: "quality.approval" },
          { id: "approve-right", type: "human_gate", uses: "quality.approval" }
        ]),
        registry
      })
    ).toThrowError(expect.objectContaining({ code: "workflow_parallel_hitl_unsupported" }));

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
});
