import type { JsonObject } from "../../core/runtime/backends/contracts.js";
import {
  runtimeDurabilityRecoveryRequiredFrom,
  runtimeError
} from "../../core/runtime/errors.js";
import type {
  WorkflowRuntimeFactory,
  WorkflowRuntimeRunner
} from "../../core/workflow/runner-port.js";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import { applyWorkflowGraphUpdate } from "./workflow-state.js";
import { compileLangGraphWorkflow } from "./workflow-graph.js";
import {
  runCompiledWorkflowWithScheduler,
  resumeCompiledWorkflowWithScheduler,
  type WorkflowNodeAttemptOutcome,
  type WorkflowNodeScheduler,
  type WorkflowNodeSchedulerResult
} from "../workflow/runner-engine.js";
import {
  appendWorkflowRuntimeStreamLog,
} from "../workflow/stream-observer.js";
import {
  assertLangGraphOutputState,
  projectLangGraphProtocolEvent
} from "./stream-events.js";
import type {
  ResumeWorkflowInput,
  RunWorkflowInput
} from "../../core/workflow/execution-contracts.js";
import type {
  ResumeCompiledWorkflowInput,
  RunCompiledWorkflowInput,
  WorkflowRunResult
} from "./workflow-runner-types.js";
import {
  mergeNodeFailuresWithRuntimeState,
  nodeAttemptFailures,
  WorkflowNodeAttemptFailure
} from "../workflow/failure-state.js";
import type { WorkflowNodeRunUpdate } from "../workflow/node-runner.js";

type WaitingForInputResult = Extract<WorkflowRunResult, { status: "waiting_for_input" }>;

export type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
export type {
  ResumeCompiledWorkflowInput,
  RunCompiledWorkflowInput,
  WorkflowAgentDefaults,
  WorkflowAgentInputMap,
  WorkflowBuiltInExecutor,
  WorkflowBuiltInMetadataResolver,
  WorkflowPatternExecutor,
  WorkflowRunResult
} from "./workflow-runner-types.js";

export function createLangGraphWorkflowRuntimeRunner(): WorkflowRuntimeRunner<
  RunCompiledWorkflowInput,
  ResumeCompiledWorkflowInput,
  WorkflowRunResult
> {
  return {
    run: runCompiledWorkflow,
    resume: resumeCompiledWorkflow
  };
}

export const langGraphWorkflowRuntimeFactory = {
  id: "langgraph",
  create(options: JsonObject) {
    if (Object.keys(options).length > 0) {
      throw runtimeError(
        "LangGraph workflow runtime options are not supported",
        "runtime_backend_invalid",
        { details: { workflow_runtime_id: "langgraph" } }
      );
    }

    const runner = createLangGraphWorkflowRuntimeRunner();
    return {
      run(input: RunWorkflowInput) {
        return runner.run(input);
      },
      resume(input: ResumeWorkflowInput) {
        return runner.resume(input);
      }
    };
  }
} satisfies WorkflowRuntimeFactory<
  RunWorkflowInput,
  ResumeWorkflowInput,
  WorkflowRunResult
>;

class WorkflowWaitingForInput extends Error {
  readonly result: WaitingForInputResult;

  constructor(result: WaitingForInputResult) {
    super("Workflow is waiting for input");
    this.name = "WorkflowWaitingForInput";
    this.result = result;
  }
}

class WorkflowHalted extends Error {
  readonly nodeId: string;
  readonly update: WorkflowNodeRunUpdate;

  constructor(nodeId: string, update: WorkflowNodeRunUpdate) {
    super("Workflow completed early by loop control");
    this.name = "WorkflowHalted";
    this.nodeId = nodeId;
    this.update = update;
  }
}

export async function runCompiledWorkflow(
  input: RunCompiledWorkflowInput
): Promise<WorkflowRunResult> {
  return await runCompiledWorkflowWithScheduler(input, runLangGraphWorkflowNodes);
}

export async function resumeCompiledWorkflow(
  input: ResumeCompiledWorkflowInput
): Promise<WorkflowRunResult> {
  return await resumeCompiledWorkflowWithScheduler(input, runLangGraphWorkflowNodes);
}

const runLangGraphWorkflowNodes: WorkflowNodeScheduler<RunCompiledWorkflowInput> = async ({
  input,
  initialState,
  nodes,
  startIndex,
  deferredFinalReportIds,
  runNode
}) => {
  let reducedState = initialState;
  const graph = compileLangGraphWorkflow({
    input,
    nodes,
    startIndex,
    deferredFinalReportIds,
    runNode: async (node, state) => {
      const update = await runLangGraphNode({
        state: state as LunaRuntimeState,
        node,
        runNode
      });
      reducedState = applyWorkflowGraphUpdate(reducedState, update);
      return update;
    }
  });

  try {
    const result = await streamLangGraphWorkflow({
      graph,
      input,
      initialState
    });
    return result;
  } catch (cause) {
    if (cause instanceof WorkflowHalted) {
      return {
        kind: "completed",
        state: applyWorkflowGraphUpdate(reducedState, cause.update),
        halted_node_id: cause.nodeId
      };
    }
    if (cause instanceof WorkflowWaitingForInput) {
      return nativeWaitingSchedulerResult(cause.result);
    }
    const durabilityFailure = runtimeDurabilityRecoveryRequiredFrom(cause);
    if (durabilityFailure !== undefined) {
      throw durabilityFailure;
    }
    const failures = nodeAttemptFailures(cause);
    const primaryFailure = failures[0];
    if (primaryFailure !== undefined) {
      throw new WorkflowNodeAttemptFailure(
        primaryFailure.runtimeCause,
        mergeNodeFailuresWithRuntimeState(failures, reducedState)
      );
    }
    throw cause;
  }
};

function nativeWaitingSchedulerResult(
  waiting: WaitingForInputResult
): WorkflowNodeSchedulerResult {
  return {
    kind: "waiting_for_input",
    interrupt_id: waiting.interrupt_id,
    checkpoint_id: waiting.checkpoint_id,
    state: waiting.state
  };
}

async function streamLangGraphWorkflow({
  graph,
  input,
  initialState
}: {
  readonly graph: ReturnType<typeof compileLangGraphWorkflow>;
  readonly input: RunCompiledWorkflowInput;
  readonly initialState: LunaRuntimeState;
}): Promise<WorkflowNodeSchedulerResult> {
  const stream = await graph.streamEvents(initialState, {
    configurable: { thread_id: input.run.run_id },
    version: "v3",
    streamMode: ["updates", "values", "checkpoints", "tasks"]
  });

  for await (const chunk of stream) {
    const parsed = projectLangGraphProtocolEvent(chunk);
    if (parsed.event !== undefined) {
      await appendWorkflowRuntimeStreamLog(input, parsed.event);
    }
  }

  if (stream.interrupted) {
      throw runtimeError("LangGraph workflow stream interrupted without a Luna interrupt", "runtime_state_invalid", {
        details: { workflow_id: input.workflow.id, interrupt_count: stream.interrupts.length }
      });
  }

  const state = assertLangGraphOutputState(await stream.output);
  return { kind: "completed", state };
}

async function runLangGraphNode({
  state,
  node,
  runNode
}: {
  readonly state: LunaRuntimeState;
  readonly node: CompiledWorkflowNode;
  readonly runNode: LangGraphRunNode;
}): Promise<WorkflowNodeRunUpdate> {
  const result = await runNode(node, state);
  if (result.kind === "waiting_for_input") {
    const waiting = {
      status: "waiting_for_input",
      interrupt_id: result.interrupt_id,
      checkpoint_id: result.checkpoint_id,
      state: result.state
    } satisfies WaitingForInputResult;
    throw new WorkflowWaitingForInput(waiting);
  }

  if (result.halt_workflow === true) {
    throw new WorkflowHalted(node.id, result.update);
  }

  return result.update;
}

type LangGraphRunNode = (
  node: CompiledWorkflowNode,
  state: LunaRuntimeState
) => Promise<WorkflowNodeAttemptOutcome>;
