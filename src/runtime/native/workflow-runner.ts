import { runtimeError } from "../../core/runtime/errors.js";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import type {
  ResumeWorkflowInput,
  RunWorkflowInput,
  WorkflowRunResult
} from "../../core/workflow/execution-contracts.js";
import type {
  WorkflowRuntimeFactory,
  WorkflowRuntimeFactoryContext,
  WorkflowRuntimeRunner
} from "../../core/workflow/runner-port.js";
import {
  runCompiledWorkflowWithScheduler,
  resumeCompiledWorkflowWithScheduler,
  type WorkflowNodeScheduler
} from "../workflow/runner-engine.js";
import type { WorkflowNodeRunUpdate } from "../workflow/node-runner.js";

export function createNativeWorkflowRuntimeRunner(): WorkflowRuntimeRunner<
  RunWorkflowInput,
  ResumeWorkflowInput,
  WorkflowRunResult
> {
  return {
    run(input) {
      return runCompiledWorkflowWithScheduler(input, runNativeWorkflowNodes);
    },
    resume(input) {
      return resumeCompiledWorkflowWithScheduler(input, runNativeWorkflowNodes);
    }
  };
}

export const nativeWorkflowRuntimeFactory = {
  id: "native",
  create(options, _context: WorkflowRuntimeFactoryContext) {
    if (Object.keys(options).length > 0) {
      throw runtimeError(
        "Native workflow runtime options are not supported",
        "runtime_backend_invalid",
        { details: { workflow_runtime_id: "native" } }
      );
    }

    return createNativeWorkflowRuntimeRunner();
  }
} satisfies WorkflowRuntimeFactory<
  RunWorkflowInput,
  ResumeWorkflowInput,
  WorkflowRunResult
>;

const runNativeWorkflowNodes: WorkflowNodeScheduler<RunWorkflowInput> = async ({
  initialState,
  nodes,
  runNode
}) => {
  let state = initialState;
  for (const node of nodes) {
    const result = await runNode(node, state);
    if (result.kind === "waiting_for_input") {
      return result;
    }

    state = applyNodeUpdate(state, result.update);
  }

  return { kind: "completed", state };
};

function applyNodeUpdate(
  state: LunaRuntimeState,
  update: WorkflowNodeRunUpdate
): LunaRuntimeState {
  return {
    ...state,
    node_statuses: { ...state.node_statuses, ...update.node_statuses },
    attempts: { ...state.attempts, ...update.attempts },
    steps: { ...state.steps, ...update.steps },
    artifact_refs: [
      ...state.artifact_refs,
      ...(update.artifact_refs ?? [])
    ]
  };
}
