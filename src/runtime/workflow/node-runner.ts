import {
  assertCheckpointJsonValue,
  type JsonValue
} from "../../core/runtime/json.js";
import { runtimeError } from "../../core/runtime/errors.js";
import { succeedNode } from "../../core/runtime/lifecycle.js";
import type {
  LunaRuntimeState,
  RuntimeArtifactRef
} from "../../core/runtime/state.js";
import {
  unwrapNodeOutputWithBinaryAssets,
  type NodeBinaryAssetChannel
} from "../../core/runtime/artifacts/binary-asset.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";
import type { ExecutionPolicyDecision } from "../../core/workflow/execution-policy.js";
import { runtimeContextSnapshot } from "../../core/workflow/runner-context.js";
import { withWorkflowLocks } from "../../core/workflow/runner-locks.js";
import type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
import { executeWorkflowNode } from "./node-executor.js";
import {
  beginWorkflowNodeAttempt,
  failObservedWorkflowNodeAttempt,
  observeWorkflowNodeStarted
} from "./node-attempt-lifecycle.js";
import { saveNodeOutputWrite } from "./node-durability.js";
import {
  finalizePersistedWorkflowNodeOutput,
  type CompletedWorkflowNodeAttempt,
  type WorkflowNodeExecutionProjection
} from "./node-output-finalizer.js";
import { assertNodeOutputMatchesSchema } from "./node-output-validation.js";
import {
  checkpointId,
  interruptId,
  waitForHumanInput
} from "./interrupts.js";
import { resolveNodeInput } from "../../core/workflow/runner-input.js";
import { runDurableLoop } from "./durable-loop.js";
import { committedBinaryAssetRefs } from "./node-output-assets.js";

export type { WorkflowNodeRunUpdate } from "./node-output-finalizer.js";
export { assertNodeOutputMatchesSchema } from "./node-output-validation.js";

export type WorkflowNodeAttemptOutcome =
  | CompletedWorkflowNodeAttempt
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
  decision,
  projection
}: {
  readonly input: RunWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly node: CompiledWorkflowNode;
  readonly decision: ExecutionPolicyDecision;
  readonly projection?: WorkflowNodeExecutionProjection;
}): Promise<WorkflowNodeAttemptOutcome> {
  if (input.observability !== undefined) {
    let committedOutcome: WorkflowNodeAttemptOutcome | undefined;
    try {
      return await input.observability.recorder.withSpan(
        {
          name: `node.${node.id}`,
          kind: node.kind === "interrupt" ? "interrupt" : "node",
          nodeId: node.id,
          capabilityId: "capability_id" in node
            ? node.capability_id
            : undefined,
          attributes: { "luna.node.kind": node.kind },
          metadata: {
            yaml_path: node.yaml_path,
            source: node.source
          }
        },
        async (span) => {
          const outcome = await runWorkflowNodeAttemptBody({
            input,
            state,
            runtimeContext,
            node,
            decision,
            projection
          });
          committedOutcome = outcome;
          if (outcome.kind === "waiting_for_input") {
            span.setStatus("waiting");
            await span.addEvent("interrupt.waiting", {
              interrupt_id: outcome.interrupt_id,
              checkpoint_id: outcome.checkpoint_id
            });
          }
          return outcome;
        }
      );
    } catch (cause) {
      if (committedOutcome !== undefined) {
        return committedOutcome;
      }
      throw cause;
    }
  }

  return await runWorkflowNodeAttemptBody({
    input,
    state,
    runtimeContext,
    node,
    decision,
    projection
  });
}

async function runWorkflowNodeAttemptBody({
  input,
  state,
  runtimeContext,
  node,
  decision,
  projection
}: {
  readonly input: RunWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly node: CompiledWorkflowNode;
  readonly decision: ExecutionPolicyDecision;
  readonly projection?: WorkflowNodeExecutionProjection;
}): Promise<WorkflowNodeAttemptOutcome> {
  input.signal?.throwIfAborted();
  const active = beginWorkflowNodeAttempt(state, node);
  let output: unknown;
  let outputAssetRefs: RuntimeArtifactRef[] = [];
  let binaryAssets: NodeBinaryAssetChannel | undefined;
  let haltWorkflow = false;
  try {
    await observeWorkflowNodeStarted({ input, node, active });
    if (node.kind === "interrupt") {
      const reviewInput = await resolveNodeInput(node, active.state, runtimeContext, input);
      assertCheckpointJsonValue(reviewInput);
      const waiting = await waitForHumanInput(input, active.state, node, reviewInput);
      return {
        kind: "waiting_for_input",
        interrupt_id: interruptId(input.run.run_id, node.id),
        checkpoint_id: checkpointId(input.run.run_id, node.id),
        state: waiting
      };
    } else if (node.kind === "loop") {
      const loop = await withWorkflowLocks({
        decision,
        lockManager: input.lockManager,
        runtimeContext,
        run: async () => await runDurableLoop(input, active.state, runtimeContext, node)
      });
      if (loop.kind === "waiting_for_input") {
        return loop;
      }
      output = loop.output;
      haltWorkflow = loop.halt_workflow;
    } else {
      output = await withWorkflowLocks({
        decision,
        lockManager: input.lockManager,
        runtimeContext,
        run: async () => {
          input.signal?.throwIfAborted();
          await input.onBeforeNodeExecution?.({
            node_id: node.id,
            attempt: active.attempt
          });
          input.signal?.throwIfAborted();
          return await executeWorkflowNode(
            input,
            active.state,
            runtimeContextSnapshot(runtimeContext),
            node
          );
        }
      });
    }
    input.signal?.throwIfAborted();
    const executionOutput = unwrapNodeOutputWithBinaryAssets(output);
    output = executionOutput.output;
    binaryAssets = executionOutput.binary_assets;
    assertNodeOutputMatchesSchema(node, output);
    assertCheckpointJsonValue(output);
    outputAssetRefs = await committedBinaryAssetRefs(
      binaryAssets,
      node.id,
      active.state.artifact_refs,
      input.artifactPublisher
    );
    input.signal?.throwIfAborted();
    await saveNodeOutputWrite({ input, node, output, binaryAssets });
    input.signal?.throwIfAborted();
  } catch (cause) {
    return await failObservedWorkflowNodeAttempt({
      input,
      node,
      active,
      state: active.state,
      cause
    });
  }

  const completed = await finalizePersistedWorkflowNodeOutput({
    input,
    runtimeContext,
    node,
    decision,
    output,
    active,
    projection,
    outputAssetRefs,
    binaryAssets
  });
  return haltWorkflow ? { ...completed, halt_workflow: true } : completed;
}

/**
 * Finishes a node whose executor output is already durable. The executor and
 * its locks are never re-entered; the shared finalizer performs the exact same
 * artifact and completion protocol used after a first execution.
 */
export async function recoverPersistedWorkflowNodeAttempt({
  input,
  state,
  runtimeContext,
  node,
  decision,
  output,
  projection,
  binaryAssets
}: {
  readonly input: RunWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly node: CompiledWorkflowNode;
  readonly decision: ExecutionPolicyDecision;
  readonly output: JsonValue;
  readonly projection?: WorkflowNodeExecutionProjection;
  readonly binaryAssets?: NodeBinaryAssetChannel;
}): Promise<WorkflowNodeAttemptOutcome> {
  input.signal?.throwIfAborted();
  const active = beginWorkflowNodeAttempt(state, node);
  await observeWorkflowNodeStarted({
    input,
    node,
    active,
    outputAlreadyDurable: true
  });
  return await finalizePersistedWorkflowNodeOutput({
    input,
    runtimeContext,
    node,
    decision,
    output,
    active,
    projection,
    binaryAssets
  });
}

/**
 * Produces lifecycle-only graph output for a node whose output, artifacts, and
 * completion marker were all rehydrated. No executor or publisher is invoked.
 */
export function skipPersistedCompletedWorkflowNode({
  state,
  node
}: {
  readonly state: LunaRuntimeState;
  readonly node: CompiledWorkflowNode;
}): WorkflowNodeAttemptOutcome {
  if (!Object.prototype.hasOwnProperty.call(state.steps, node.id)) {
    throw runtimeError(
      "Completed node marker is missing its rehydrated output",
      "runtime_state_invalid",
      { details: { node_id: node.id } }
    );
  }
  const active = beginWorkflowNodeAttempt(state, node);
  const succeeded = succeedNode(active.state, node.id);
  return {
    kind: "completed",
    update: {
      node_statuses: { [node.id]: succeeded.node_statuses[node.id] },
      attempts: { [node.id]: succeeded.attempts[node.id] },
      steps: {}
    }
  };
}
