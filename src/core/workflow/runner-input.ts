import jsonata from "jsonata";
import type { LunaRuntimeState } from "../runtime/state.js";
import type { RunHandle } from "../runtime/run-handle.js";
import type { JsonValue } from "../runtime/json.js";
import {
  isExpressionObject,
  WorkflowExpressionError
} from "./expression.js";
import type { CompiledWorkflowNode } from "./compiler.js";
import type { WorkflowRuntimeContext } from "./runtime-context.js";

type NodeInputResolutionContext = {
  readonly invocation: JsonValue;
  readonly config: JsonValue;
  readonly run: RunHandle;
};

export async function resolveNodeInput(
  node: CompiledWorkflowNode,
  state: LunaRuntimeState,
  runtimeContext: WorkflowRuntimeContext,
  input: NodeInputResolutionContext
): Promise<unknown> {
  const sourceInput =
    node.source.type === "agent" ||
    node.source.type === "built_in" ||
    node.source.type === "pattern" ||
    node.source.type === "human_gate" ||
    node.source.type === "workflow"
      ? node.source.input ?? {}
      : {};

  return await resolveWorkflowRuntimeValue(sourceInput, {
    root: {
      invocation: input.invocation,
      config: input.config,
      run: input.run,
      repository: runtimeContext.repository,
      workspace: runtimeContext.workspace,
      steps: state.steps
    },
    path: `${node.yaml_path}.input`,
    capability: node.capability_id
  });
}

export async function resolveWorkflowRuntimeValue(
  value: unknown,
  context: { root: unknown; path: string; capability: string }
): Promise<unknown> {
  if (isExpressionObject(value)) {
    try {
      const evaluated = await jsonata(value.expression).evaluate(context.root);
      if (evaluated === undefined) {
        throw new WorkflowExpressionError(
          "workflow_expression_unresolved",
          `Expression at ${context.path} for ${context.capability} resolved to undefined.`,
          { path: context.path, capability: context.capability }
        );
      }

      return evaluated;
    } catch (cause) {
      if (cause instanceof WorkflowExpressionError) {
        throw cause;
      }

      throw new WorkflowExpressionError(
        "workflow_expression_invalid",
        `Expression at ${context.path} for ${context.capability} failed during runtime evaluation.`,
        { path: context.path, capability: context.capability }
      );
    }
  }

  if (Array.isArray(value)) {
    return await Promise.all(
      value.map((item, index) =>
        resolveWorkflowRuntimeValue(item, {
          ...context,
          path: `${context.path}[${index}]`
        })
      )
    );
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, nested]) => [
          key,
          await resolveWorkflowRuntimeValue(nested, {
            ...context,
            path: `${context.path}.${key}`
          })
        ])
      )
    );
  }

  return value;
}
