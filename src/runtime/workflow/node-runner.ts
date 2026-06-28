import { matchesJsonSchema } from "../../core/capabilities/json-schema.js";
import type { JsonSchemaLike } from "../../core/capabilities/json-schema-types.js";
import { runtimeError } from "../../core/runtime/errors.js";
import {
  startNodeAttempt,
  succeedNode
} from "../../core/runtime/lifecycle.js";
import {
  publishNodeOutput,
  type LunaRuntimeState
} from "../../core/runtime/state.js";
import { assertCheckpointJsonValue } from "../../core/runtime/json.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";
import { appendWorkflowEvent } from "../../core/workflow/events.js";
import type { ExecutionPolicyDecision } from "../../core/workflow/execution-policy.js";
import {
  promoteWorkspaceOutput,
  runtimeContextSnapshot
} from "../../core/workflow/runner-context.js";
import { withWorkflowLocks } from "../../core/workflow/runner-locks.js";
import type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
import { publishArtifactsForNode } from "./node-artifacts.js";
import { executeWorkflowNode } from "./node-executor.js";
import {
  checkpointId,
  interruptId,
  waitForHumanInput
} from "./interrupts.js";
import { saveNodeOutputWrite } from "./checkpoints.js";

export type WorkflowNodeRunUpdate = {
  readonly node_statuses: LunaRuntimeState["node_statuses"];
  readonly attempts: LunaRuntimeState["attempts"];
  readonly steps: LunaRuntimeState["steps"];
  readonly artifact_refs?: LunaRuntimeState["artifact_refs"];
};

export type WorkflowNodeAttemptOutcome =
  | {
      readonly kind: "completed";
      readonly update: WorkflowNodeRunUpdate;
    }
  | {
      readonly kind: "waiting_for_input";
      readonly interrupt_id: string;
      readonly checkpoint_id: string;
      readonly state: LunaRuntimeState;
    };

export async function runWorkflowNodeAttempt({
  input,
  state,
  runtimeContext,
  node,
  decision
}: {
  readonly input: RunWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly node: CompiledWorkflowNode;
  readonly decision: ExecutionPolicyDecision;
}): Promise<WorkflowNodeAttemptOutcome> {
  const started = startNodeAttempt(state, node.id, 1);
  await appendWorkflowEvent(input, "node.started", node.id);

  if (node.kind === "interrupt") {
    const waiting = await waitForHumanInput(input, started, node);
    return {
      kind: "waiting_for_input",
      interrupt_id: interruptId(input.run.run_id, node.id),
      checkpoint_id: checkpointId(input.run.run_id, node.id),
      state: waiting
    };
  }

  let output: unknown;
  try {
    output = await withWorkflowLocks({
      decision,
      lockManager: input.lockManager,
      runtimeContext,
      run: async () =>
        await executeWorkflowNode(
          input,
          started,
          runtimeContextSnapshot(runtimeContext),
          node
        )
    });
  } catch (cause) {
    await appendWorkflowEvent(input, "node.failed", node.id);
    throw cause;
  }

  assertNodeOutputMatchesSchema(node, output);
  assertCheckpointJsonValue(output);
  await saveNodeOutputWrite({ input, node, output });

  const published = publishNodeOutput(started, node.id, output);
  const artifactRefs = await publishArtifactsForNode(input, node, output, started);
  const withArtifacts = artifactRefs.length === 0
    ? published
    : {
        ...published,
        artifact_refs: [
          ...published.artifact_refs,
          ...artifactRefs
        ]
      };
  promoteWorkspaceOutput(runtimeContext, decision, output);
  const succeeded = succeedNode(withArtifacts, node.id);
  await appendWorkflowEvent(input, "node.succeeded", node.id);

  return {
    kind: "completed",
    update: {
      node_statuses: { [node.id]: succeeded.node_statuses[node.id] },
      attempts: { [node.id]: succeeded.attempts[node.id] },
      steps: { [node.id]: output },
      ...(artifactRefs.length === 0 ? {} : { artifact_refs: artifactRefs })
    }
  };
}

export function assertNodeOutputMatchesSchema(
  node: CompiledWorkflowNode,
  output: unknown
): void {
  if (!matchesJsonSchema(node.output_schema as JsonSchemaLike, output)) {
    throw runtimeError("Node output failed schema validation", "runtime_node_output_schema_invalid", {
      details: { node_id: node.id, yaml_path: node.yaml_path, capability: node.capability_id }
    });
  }
}
