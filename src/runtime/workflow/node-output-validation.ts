import { matchesJsonSchema } from "../../core/capabilities/json-schema.js";
import type { JsonSchemaLike } from "../../core/capabilities/json-schema-types.js";
import { runtimeError } from "../../core/runtime/errors.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";

export function assertNodeOutputMatchesSchema(
  node: CompiledWorkflowNode,
  output: unknown
): void {
  if (!matchesJsonSchema(node.output_schema as JsonSchemaLike, output)) {
    throw runtimeError(
      "Node output failed schema validation",
      "runtime_node_output_schema_invalid",
      {
        details: {
          node_id: node.id,
          yaml_path: node.yaml_path,
          capability: node.capability_id
        }
      }
    );
  }
}
