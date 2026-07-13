import { describe, expect, it } from "vitest";
import { composedWorkflowNodes } from "../../../src/core/workflow/composition.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import {
  validateNodesAgainstCapabilities,
  validateWorkflowCallInputs
} from "../../../src/core/workflow/definition-validation.js";

function workflow(
  id: string,
  nodes: WorkflowDefinition["graph"]["nodes"],
  compositions?: WorkflowDefinition["compositions"]
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
    capabilities: [],
    graph: { nodes },
    revision: `${id}-revision`,
    external_definition_digests: {},
    execution: { max_concurrency: 1 },
    requires: { repository: false },
    observability: { exporters: { runtime_log: { enabled: false, required: false } } },
    subagent_policy: { allow_write: false },
    ...(compositions === undefined ? {} : { compositions })
  };
}

describe("composition-tree projection", () => {
  it("encodes path segments so direct and nested node ids cannot collide", () => {
    const child = workflow("child", [
      { id: "b", type: "workflow", workflow: "leaf", input: {} },
      { id: "slash/%", type: "workflow", workflow: "leaf", input: {} }
    ], { leaf: workflow("leaf", []) });
    const parent = workflow("parent", [
      { id: "a/b", type: "workflow", workflow: "leaf", input: {} },
      { id: "a", type: "workflow", workflow: "child", input: {} },
      { id: "a.b", type: "workflow", workflow: "leaf", input: {} }
    ], { child, leaf: workflow("leaf", []) });

    const ids = composedWorkflowNodes(parent).map(({ qualifiedNodeId }) => qualifiedNodeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("a%2Fb");
    expect(ids).toContain("a/b");
    expect(ids).toContain("a/slash%2F%25");
    expect(ids).toContain("a.b");
  });

  it("projects durable loop body nodes under their owning loop", () => {
    const root = workflow("loop-owner", [{
      id: "editorial/loop",
      type: "loop",
      body: {
        nodes: [
          { id: "draft/image", type: "built_in", uses: "test.generate" },
          {
            id: "review",
            type: "human_gate",
            uses: "hitl.review"
          }
        ]
      },
      repeat_when: { expression: "false" },
      result: { expression: "{}" }
    }]);

    const projected = composedWorkflowNodes(root);
    expect(projected.map(({ qualifiedNodeId }) => qualifiedNodeId)).toEqual([
        "editorial%2Floop",
        "editorial%2Floop/draft%2Fimage",
        "editorial%2Floop/review"
      ]);
    expect(projected.map(({ executionBoundaryNodeId }) => executionBoundaryNodeId))
      .toEqual([
        "editorial/loop",
        "editorial%2Floop/draft%2Fimage",
        "editorial%2Floop/review"
      ]);
  });

  it("attributes composed descendants to the parent runtime call boundary", () => {
    const child = workflow("child", [
      { id: "model", type: "agent", agent: "writer", output_schema: "out.json" },
      { id: "write", type: "built_in", uses: "provider.write", after: ["model"] }
    ]);
    const parent = workflow("parent", [
      { id: "child/call", type: "workflow", workflow: "child", input: {} }
    ], { child });

    expect(composedWorkflowNodes(parent).map((entry) => ({
      id: entry.qualifiedNodeId,
      boundary: entry.executionBoundaryNodeId
    }))).toEqual([
      { id: "child%2Fcall", boundary: "child/call" },
      { id: "child%2Fcall/model", boundary: "child/call" },
      { id: "child%2Fcall/write", boundary: "child/call" }
    ]);
  });

  it("walks composition inputs inside loops without making workflow calls legal there", () => {
    const child = {
      ...workflow("child", []),
      input_schema_content: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { type: "string" } }
      }
    } satisfies WorkflowDefinition;
    const loop = {
      id: "editorial",
      type: "loop" as const,
      body: {
        nodes: [
          { id: "call", type: "workflow" as const, workflow: "child", input: {} },
          {
            id: "review",
            type: "human_gate" as const,
            uses: "hitl.approval"
          }
        ]
      },
      repeat_when: { expression: "false" },
      result: { expression: "{}" }
    };

    expect(() => validateWorkflowCallInputs([loop], { child })).toThrowError(
      expect.objectContaining({
        code: "workflow_capability_config_invalid",
        path: "$.nodes[0].body.nodes[0].input"
      })
    );
    expect(() =>
      validateNodesAgainstCapabilities([loop], [], new Set([loop.id]), undefined)
    ).toThrowError(expect.objectContaining({
      code: "workflow_schema_invalid",
      path: "$.nodes[0].body.nodes[0]"
    }));
  });
});
