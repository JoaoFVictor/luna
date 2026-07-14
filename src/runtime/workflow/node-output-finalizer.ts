import { partialArtifactPublishFailure } from "../../capabilities/artifacts/publisher.js";
import {
  runtimeError,
  RuntimeDurabilityRecoveryRequiredError
} from "../../core/runtime/errors.js";
import { assertCheckpointJsonValue, type JsonValue } from "../../core/runtime/json.js";
import type { NodeBinaryAssetChannel } from "../../core/runtime/artifacts/binary-asset.js";
import { succeedNode } from "../../core/runtime/lifecycle.js";
import {
  publishNodeOutput,
  type LunaRuntimeState
} from "../../core/runtime/state.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";
import type { ExecutionPolicyDecision } from "../../core/workflow/execution-policy.js";
import { sha256Digest } from "../../core/workflow/definition-digests.js";
import { promoteWorkspaceOutput } from "../../core/workflow/runner-context.js";
import type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
import { publishArtifactsForNode } from "./node-artifacts.js";
import {
  failObservedWorkflowNodeAttempt,
  observeWorkflowNodeSucceeded,
  type ActiveWorkflowNodeAttempt
} from "./node-attempt-lifecycle.js";
import { saveNodeCompletionWrite } from "./node-durability.js";
import { assertNodeOutputMatchesSchema } from "./node-output-validation.js";
import { committedBinaryAssetRefs } from "./node-output-assets.js";
import { mergeRuntimeReferences } from "./runtime-reference-codec.js";

export type WorkflowNodeRunUpdate = {
  readonly node_statuses: LunaRuntimeState["node_statuses"];
  readonly attempts: LunaRuntimeState["attempts"];
  readonly steps: LunaRuntimeState["steps"];
  readonly artifact_refs?: LunaRuntimeState["artifact_refs"];
};

export type CompletedWorkflowNodeAttempt = {
  readonly kind: "completed";
  readonly update: WorkflowNodeRunUpdate;
  readonly halt_workflow?: true;
};

export type WorkflowNodeExecutionProjection = {
  /** State key used by expressions; physical execution identity remains node.id. */
  readonly state_node_id: string;
  readonly artifact_path_prefix?: string;
  readonly replace_existing_state?: boolean;
  readonly completion_failure?: "recover";
};

/**
 * The single authority for finishing an already durable node output.
 *
 * Both first execution and crash recovery enter here only after the exact
 * output write exists. Artifact publication, workspace promotion, completion
 * persistence, state projection, lifecycle observation, and failure
 * classification therefore cannot drift between those paths.
 */
export async function finalizePersistedWorkflowNodeOutput({
  input,
  runtimeContext,
  node,
  decision,
  output,
  active,
  projection,
  outputAssetRefs = [],
  binaryAssets
}: {
  readonly input: RunWorkflowInput;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly node: CompiledWorkflowNode;
  readonly decision: ExecutionPolicyDecision;
  readonly output: JsonValue;
  readonly active: ActiveWorkflowNodeAttempt;
  readonly projection?: WorkflowNodeExecutionProjection;
  readonly outputAssetRefs?: ReadonlyArray<
    LunaRuntimeState["artifact_refs"][number]
  >;
  readonly binaryAssets?: NodeBinaryAssetChannel;
}): Promise<CompletedWorkflowNodeAttempt> {
  let attemptState = active.state;
  try {
    assertNodeOutputMatchesSchema(node, output);
    assertCheckpointJsonValue(output);
    input.signal?.throwIfAborted();

    const stateNodeId = projection?.state_node_id ?? node.id;
    const projectedOutput = active.state.steps[stateNodeId];
    const outputAlreadyProjected = Object.prototype.hasOwnProperty.call(
      active.state.steps,
      stateNodeId
    );
    if (
      outputAlreadyProjected &&
      projection?.replace_existing_state !== true &&
      sha256Digest(projectedOutput) !== sha256Digest(output)
    ) {
      throw runtimeError(
        "Persisted node output conflicts with its runtime state projection",
        "runtime_state_invalid",
        { details: { node_id: node.id } }
      );
    }
    const withOutput = outputAlreadyProjected
      ? projection?.replace_existing_state === true
        ? {
            ...active.state,
            steps: { ...active.state.steps, [stateNodeId]: output }
          }
        : active.state
      : publishNodeOutput(active.state, stateNodeId, output);
    attemptState = withOutput;

    let artifactRefs: LunaRuntimeState["artifact_refs"];
    try {
      artifactRefs = await publishArtifactsForNode(
        input,
        node,
        output,
        withOutput,
        projection?.artifact_path_prefix === undefined
          ? undefined
          : {
              node_id: node.id,
              path_prefix: projection.artifact_path_prefix
            }
      );
    } catch (cause) {
      const partialFailure = partialArtifactPublishFailure(cause);
      if (partialFailure === undefined) {
        throw cause;
      }
      attemptState = {
        ...withOutput,
        artifact_refs: [
          ...withOutput.artifact_refs,
          ...partialFailure.publishedArtifacts.map((artifact) => ({
            id: artifact.id,
            uri: artifact.uri,
            node_id: artifact.node_id
          }))
        ]
      };
      throw partialFailure.runtimeCause;
    }
    const binaryAssetRefs = await committedBinaryAssetRefs(
      binaryAssets,
      node.id,
      mergeRuntimeReferences(
        withOutput.artifact_refs,
        artifactRefs,
        outputAssetRefs
      ),
      input.artifactPublisher
    );
    artifactRefs = mergeRuntimeReferences(
      artifactRefs,
      outputAssetRefs,
      binaryAssetRefs
    );

    const withArtifacts = artifactRefs.length === 0
      ? withOutput
      : {
          ...withOutput,
          artifact_refs: [...withOutput.artifact_refs, ...artifactRefs]
        };
    attemptState = withArtifacts;
    input.signal?.throwIfAborted();
    promoteWorkspaceOutput(runtimeContext, decision, output);
    const succeeded = succeedNode(withArtifacts, node.id);
    await saveNodeCompletionWrite({
      input,
      node,
      output,
      artifactRefs,
      interruptRefs: []
    });
    await observeWorkflowNodeSucceeded({ input, node, active, succeeded });

    return {
      kind: "completed",
      update: {
        node_statuses: { [node.id]: succeeded.node_statuses[node.id] },
        attempts: { [node.id]: succeeded.attempts[node.id] },
        steps: { [stateNodeId]: output },
        ...(artifactRefs.length === 0 ? {} : { artifact_refs: artifactRefs })
      }
    };
  } catch (cause) {
    if (projection?.completion_failure === "recover") {
      throw new RuntimeDurabilityRecoveryRequiredError(
        "Node output is durable but completion requires recovery",
        {
          cause,
          details: {
            node_id: node.id,
            artifact_count: attemptState.artifact_refs.length
          }
        }
      );
    }
    return await failObservedWorkflowNodeAttempt({
      input,
      node,
      active,
      state: attemptState,
      cause
    });
  }
}
