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
            uses: "hitl.approval",
            after: ["call"]
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
