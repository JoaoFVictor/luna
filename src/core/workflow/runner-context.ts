import {
  assertCheckpointJsonValue,
  stableJson,
  type JsonObject,
  type JsonValue
} from "../runtime/json.js";
import { runtimeError } from "../runtime/errors.js";
import type { ExecutionPolicyDecision } from "./execution-policy.js";
import type { CompiledWorkflowNode } from "./compiler.js";
import type { WorkflowRuntimeContext } from "./runtime-context.js";

export type WorkflowContextDecisionResolver = (
  node: CompiledWorkflowNode
) => ExecutionPolicyDecision;

export function runtimeContextSnapshot(
  runtimeContext: WorkflowRuntimeContext
): WorkflowRuntimeContext {
  const snapshot = structuredClone(runtimeContext) as WorkflowRuntimeContext;
  if (process.env.NODE_ENV !== "production") {
    deepFreeze(snapshot);
  }

  return snapshot;
}

export function promoteWorkspaceOutput(
  runtimeContext: WorkflowRuntimeContext,
  decision: ExecutionPolicyDecision,
  output: unknown
): void {
  if (!decision.capturesWorkspace || !isWorkspaceRecordOutput(output)) {
    return;
  }
  assertCheckpointJsonValue(output, "$.workspace");

  if (runtimeContext.workspace === undefined) {
    runtimeContext.workspace = output;
    return;
  }

  assertCheckpointJsonValue(runtimeContext.workspace, "$.runtimeContext.workspace");
  if (stableJson(runtimeContext.workspace) !== stableJson(output)) {
    throw runtimeError("Workflow workspace was captured more than once", "runtime_state_invalid", {
      details: { reason: "workspace_capture_conflict" }
    });
  }
}

export function rehydrateRuntimeContextFromSteps({
  nodes,
  steps,
  runtimeContext,
  decisionForNode
}: {
  readonly nodes: readonly CompiledWorkflowNode[];
  readonly steps: Record<string, JsonValue>;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly decisionForNode: WorkflowContextDecisionResolver;
}): void {
  for (const node of nodes) {
    const output = steps[node.id];
    if (output === undefined) {
      continue;
    }

    promoteWorkspaceOutput(runtimeContext, decisionForNode(node), output);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }

  return value;
}

function isWorkspaceRecordOutput(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.run_id === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.preserved === "boolean" &&
    typeof candidate.reason === "string"
  );
}
