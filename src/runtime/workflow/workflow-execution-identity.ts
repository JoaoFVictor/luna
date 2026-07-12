import type { CheckpointRecord, SaveCheckpointInput } from "../../core/runtime/backends/contracts.js";
import {
  LUNA_RUNTIME_STATE_SCHEMA_VERSION
} from "../../core/runtime/state.js";
import {
  RuntimeError,
  RuntimeDurabilityRecoveryRequiredError,
  runtimeError
} from "../../core/runtime/errors.js";
import type { CompiledWorkflow } from "../../core/workflow/compiler.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";
import { sha256Digest } from "../../core/workflow/definition-digests.js";
import {
  checkpointMatchesInput,
  hasThreadCheckpointWritesForRecovery,
  loadCheckpointForRecovery,
  saveCheckpointExactly
} from "./checkpoint-io.js";

export async function ensureWorkflowExecutionIdentity(
  input: {
    readonly backends: RunWorkflowInput["backends"];
    readonly compiled: CompiledWorkflow;
    readonly invocation: RunWorkflowInput["invocation"];
    readonly config: RunWorkflowInput["config"];
    readonly run: RunWorkflowInput["run"];
    readonly precompleted_steps?: RunWorkflowInput["precompleted_steps"];
  },
  runId: string,
  options: {
    /**
     * An exact waiting checkpoint and its wait intent were validated before
     * this call, so their immutable resume context may safely migrate a
     * pre-identity execution.
     */
    readonly validatedLegacyResume?: boolean;
  } = {}
): Promise<void> {
  if (
    input.run.run_id !== runId ||
    input.run.workflow_id !== input.compiled.workflow_id
  ) {
    throw runtimeError(
      "Workflow execution input conflicts with its run identity",
      "runtime_checkpoint_schema_mismatch",
      { details: { run_id: runId, workflow_id: input.compiled.workflow_id } }
    );
  }
  const hasPrecompletedSteps =
    Object.keys(input.precompleted_steps ?? {}).length > 0;
  const identity = {
    identity_schema_version: hasPrecompletedSteps ? 3 : 2,
    workflow_id: input.compiled.workflow_id,
    workflow_revision: input.compiled.workflow_revision,
    invocation_digest: sha256Digest(input.invocation),
    config_digest: sha256Digest(input.config),
    run_handle_digest: sha256Digest(input.run),
    ...(hasPrecompletedSteps
      ? { precompleted_steps_digest: sha256Digest(input.precompleted_steps) }
      : {})
  } as const;
  const checkpoint: SaveCheckpointInput = {
    thread_id: runId,
    checkpoint_ns: "",
    checkpoint_id: workflowExecutionIdentityCheckpointId(runId),
    state_schema_version: LUNA_RUNTIME_STATE_SCHEMA_VERSION,
    state: { state_schema_version: LUNA_RUNTIME_STATE_SCHEMA_VERSION },
    metadata: {
      source: "workflow_execution_identity",
      ...identity
    }
  };
  const existing = await loadCheckpointForRecovery({
    input,
    threadId: runId,
    checkpointId: checkpoint.checkpoint_id,
    checkpointNs: "",
    operation: "load_workflow_execution_identity"
  });
  if (existing !== undefined) {
    if (checkpointMatchesInput(existing, checkpoint)) {
      return;
    }
    throw runtimeError(
      "Workflow run is already bound to different immutable execution inputs",
      "runtime_checkpoint_schema_mismatch",
      {
        details: {
          checkpoint_id: checkpoint.checkpoint_id,
          run_id: runId,
          workflow_id: input.compiled.workflow_id
        }
      }
    );
  }
  if (options.validatedLegacyResume !== true) {
    await assertNoDurableStateWithoutExecutionIdentity(input, runId);
  }
  await saveCheckpointExactly(input, checkpoint);
}

function workflowExecutionIdentityCheckpointId(runId: string): string {
  return `workflow-execution-identity-v2-${runId}`;
}

async function assertNoDurableStateWithoutExecutionIdentity(
  input: {
    readonly backends: RunWorkflowInput["backends"];
  },
  runId: string
): Promise<void> {
  let checkpoints: CheckpointRecord[];
  try {
    checkpoints = await input.backends.checkpoints.list(runId, { limit: 1 });
  } catch (cause) {
    throw checkpointReadRecoveryRequired(
      cause,
      "inspect_workflow_checkpoints_without_identity",
      runId
    );
  }
  if (checkpoints.length > 0) {
    throw missingExecutionIdentityError(runId);
  }

  const hasWrites = await hasThreadCheckpointWritesForRecovery({
    input,
    threadId: runId,
    operation: "inspect_workflow_writes_without_identity"
  });
  if (hasWrites) {
    throw missingExecutionIdentityError(runId);
  }
}

function missingExecutionIdentityError(runId: string): RuntimeError {
  return runtimeError(
    "Durable workflow state exists without a complete execution identity",
    "runtime_checkpoint_schema_mismatch",
    { details: { reason: "execution_identity_missing", run_id: runId } }
  );
}

function checkpointReadRecoveryRequired(
  cause: unknown,
  operation: string,
  threadId: string
): RuntimeError {
  if (cause instanceof RuntimeError) {
    return cause;
  }
  return new RuntimeDurabilityRecoveryRequiredError(
    "Checkpoint protocol read requires durable reconciliation",
    {
      cause,
      details: { operation, thread_id: threadId }
    }
  );
}
