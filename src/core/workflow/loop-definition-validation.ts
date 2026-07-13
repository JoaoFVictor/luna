import { WorkflowDefinitionError } from "./definition-errors.js";
import { analyzeWorkflowGraph } from "./graph-analysis.js";
import type { ParsedLoopNode } from "./definition-types.js";

export function validateLoopStructure(node: ParsedLoopNode, path: string): void {
  const body = node.body.nodes;
  if (body.length < 2) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Workflow loop body must contain work followed by a human gate.",
      { path: `${path}.body.nodes` }
    );
  }
  if (body.some((candidate) => candidate.type === "loop")) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Nested workflow loops are not supported.",
      { path: `${path}.body.nodes` }
    );
  }
  const unsupportedIndex = body.findIndex(
    (candidate) =>
      candidate.type !== "agent" &&
      candidate.type !== "built_in" &&
      candidate.type !== "human_gate"
  );
  if (unsupportedIndex !== -1) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Workflow loop body supports only agent, built-in, and final human-gate nodes.",
      { path: `${path}.body.nodes[${unsupportedIndex}]` }
    );
  }

  analyzeWorkflowGraph({ nodes: body });
  body.forEach((candidate, index) => {
    const expected = index === 0 ? [] : [body[index - 1]!.id];
    const actual = candidate.after ?? [];
    if (
      actual.length !== expected.length ||
      actual.some((dependency, dependencyIndex) =>
        dependency !== expected[dependencyIndex]
      )
    ) {
      throw new WorkflowDefinitionError(
        "workflow_schema_invalid",
        "Workflow loop body must be a single sequential chain.",
        { path: `${path}.body.nodes[${index}].after` }
      );
    }
  });

  const gates = body.filter((candidate) => candidate.type === "human_gate");
  if (gates.length !== 1 || body.at(-1)?.type !== "human_gate") {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Workflow loop body must end with exactly one human gate.",
      { path: `${path}.body.nodes` }
    );
  }
}
