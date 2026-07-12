import { createHash } from "node:crypto";
import { runtimeError } from "../../core/runtime/errors.js";
import type { RunHandle } from "../../core/runtime/run-handle.js";
import { finalWorkflowOutput } from "../../core/workflow/runner-output.js";
import { deferredFinalReportNodeIds } from "../../runtime/workflow/deferred-final-report.js";
import type {
  WorkflowCompositionExecutor,
  WorkflowRunResult
} from "../../core/workflow/execution-contracts.js";
import type { NativeWorkflowRunInput } from "../../runtime/composition/target-executor.js";
import { validateCheckpointState } from "../../core/runtime/state.js";

export function createNativeWorkflowCompositionExecutor(options: {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly definitionRoots?: NativeWorkflowRunInput["definitionRoots"];
  readonly runChild: (input: NativeWorkflowRunInput) => Promise<WorkflowRunResult>;
}): WorkflowCompositionExecutor {
  return async ({ workflowInput, node, input, child }) => {
    const run = childRunHandle(workflowInput.run, node.id, child.workflow.id);
    const checkpointId = `terminal-${run.run_id}-succeeded`;
    const recovered = await workflowInput.backends.checkpoints.load(run.run_id, {
      checkpointId
    });
    if (recovered !== undefined) {
      validateCheckpointState(recovered.state);
      if (
        recovered.thread_id !== run.run_id ||
        recovered.checkpoint_id !== checkpointId ||
        recovered.checkpoint_ns !== "" ||
        recovered.state_schema_version !== child.compiled.state_schema_version ||
        recovered.state.state_schema_version !== child.compiled.state_schema_version ||
        recovered.state.run_status !== "succeeded" ||
        recovered.state.workflow.id !== child.workflow.id ||
        recovered.metadata.run_status !== "succeeded" ||
        recovered.metadata.workflow_revision !== child.workflow.revision
      ) {
        throw runtimeError(
          "Composed workflow terminal checkpoint is incompatible with the pinned child revision",
          "runtime_checkpoint_schema_mismatch",
          { details: { node_id: node.id, workflow_id: child.workflow.id } }
        );
      }
      return finalWorkflowOutput(
        child.compiled,
        recovered.state,
        deferredFinalReportNodeIds(
          {
            ...workflowInput,
            compiled: child.compiled,
            workflow: child.workflow,
            invocation: recovered.state.invocation,
            config: recovered.state.config,
            run
          },
          child.compiled.nodes
        )
      );
    }

    const result = await options.runChild({
      projectRoot: options.projectRoot,
      configRoot: options.configRoot,
      target: { type: "workflow", id: child.workflow.id },
      invocation: input,
      run,
      signal: workflowInput.signal,
      ...(options.definitionRoots === undefined
        ? {}
        : { definitionRoots: options.definitionRoots }),
      onCompiledWorkflow: async (compiled) => {
        if (compiled.workflow_revision !== child.compiled.workflow_revision) {
          throw runtimeError(
            "Composed workflow revision changed after the parent was pinned",
            "runtime_state_invalid",
            { details: { node_id: node.id, workflow_id: child.workflow.id } }
          );
        }
      }
    });
    if (result.status !== "succeeded") {
      throw runtimeError(
        "Composed workflow suspended even though HITL composition is unsupported",
        "runtime_state_invalid",
        { details: { node_id: node.id, workflow_id: child.workflow.id } }
      );
    }
    return result.output;
  };
}

function childRunHandle(
  parent: RunHandle,
  nodeId: string,
  workflowId: string
): RunHandle {
  return {
    run_id: nativeComposedWorkflowRunId(parent.run_id, nodeId, workflowId),
    workflow_id: workflowId,
    attempt: parent.attempt,
    started_at: parent.started_at
  };
}

export function nativeComposedWorkflowRunId(
  parentRunId: string,
  nodeId: string,
  workflowId: string
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([parentRunId, nodeId, workflowId]))
    .digest("hex");
  const runId = `subworkflow-${digest}`;
  if (runId.length > 128 || !/^[a-z0-9._-]+$/.test(runId)) {
    throw runtimeError(
      "Derived composed workflow run id is invalid",
      "runtime_state_invalid"
    );
  }
  return runId;
}
