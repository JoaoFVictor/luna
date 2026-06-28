import type { JsonObject } from "../../core/runtime/backends/contracts.js";
import { interrupt as langGraphInterrupt } from "@langchain/langgraph";
import { runtimeError } from "../../core/runtime/errors.js";
import type {
  WorkflowRuntimeFactory,
  WorkflowRuntimeFactoryContext,
  WorkflowRuntimeRunner
} from "../../core/workflow/runner-port.js";
import { sqliteCheckpointBackendRegistration } from "../backends/sqlite/checkpoints.js";
import { LunaLangGraphCheckpointer } from "../backends/sqlite/langgraph-checkpointer.js";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import {
  type WorkflowGraphUpdate
} from "./workflow-state.js";
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
  create(options: JsonObject, context: WorkflowRuntimeFactoryContext) {
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
        return runner.run(withLangGraphRuntimeExtensions(input, context));
      },
      resume(input: ResumeWorkflowInput) {
        return runner.resume(withLangGraphRuntimeExtensions(input, context));
      }
    };
  }
} satisfies WorkflowRuntimeFactory<
  RunWorkflowInput,
  ResumeWorkflowInput,
  WorkflowRunResult
>;

function withLangGraphRuntimeExtensions<TInput extends RunWorkflowInput | ResumeWorkflowInput>(
  input: TInput,
  context: WorkflowRuntimeFactoryContext
): TInput & { readonly langGraphCheckpointer?: RunCompiledWorkflowInput["langGraphCheckpointer"] } {
  if (context.checkpoints.backendId !== sqliteCheckpointBackendRegistration.id) {
    return input;
  }

  return {
    ...input,
    langGraphCheckpointer: new LunaLangGraphCheckpointer(context.checkpoints.store)
  };
}

class WorkflowWaitingForInput extends Error {
  readonly result: WaitingForInputResult;

  constructor(result: WaitingForInputResult) {
    super("Workflow is waiting for input");
    this.name = "WorkflowWaitingForInput";
    this.result = result;
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
  let pendingNativeInterrupt: WaitingForInputResult | undefined;
  const graph = compileLangGraphWorkflow({
    input,
    nodes,
    startIndex,
    deferredFinalReportIds,
    runNode: async (node, state) =>
      await runLangGraphNode({
        state: state as LunaRuntimeState,
        node,
        useNativeInterrupt: input.langGraphCheckpointer !== undefined,
        runNode,
        onNativeInterrupt: (result) => {
          pendingNativeInterrupt = result;
        }
      })
  });

  try {
    const result = await streamLangGraphWorkflow({
      graph,
      input,
      initialState,
      pendingNativeInterrupt: () => pendingNativeInterrupt
    });
    return result;
  } catch (cause) {
    if (cause instanceof WorkflowWaitingForInput) {
      return {
        kind: "waiting_for_input",
        interrupt_id: cause.result.interrupt_id,
        checkpoint_id: cause.result.checkpoint_id,
        state: cause.result.state
      };
    }
    throw cause;
  }
};

async function streamLangGraphWorkflow({
  graph,
  input,
  initialState,
  pendingNativeInterrupt
}: {
  readonly graph: ReturnType<typeof compileLangGraphWorkflow>;
  readonly input: RunCompiledWorkflowInput;
  readonly initialState: LunaRuntimeState;
  readonly pendingNativeInterrupt: () => WaitingForInputResult | undefined;
}): Promise<WorkflowNodeSchedulerResult> {
  const stream = await graph.streamEvents(initialState, {
    configurable: { thread_id: input.run.run_id },
    version: "v3",
    streamMode: ["updates", "values", "checkpoints", "tasks"],
    ...(input.langGraphCheckpointer === undefined ? {} : { durability: "sync" })
  });

  for await (const chunk of stream) {
    const parsed = projectLangGraphProtocolEvent(chunk);
    if (parsed.event !== undefined) {
      await appendWorkflowRuntimeStreamLog(input, parsed.event);
    }
  }

  if (stream.interrupted) {
    const waiting = pendingNativeInterrupt();
    if (waiting !== undefined) {
      return {
        kind: "waiting_for_input",
        interrupt_id: waiting.interrupt_id,
        checkpoint_id: waiting.checkpoint_id,
        state: waiting.state
      };
    }

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
  useNativeInterrupt,
  runNode,
  onNativeInterrupt
}: {
  readonly state: LunaRuntimeState;
  readonly node: CompiledWorkflowNode;
  readonly useNativeInterrupt: boolean;
  readonly runNode: LangGraphRunNode;
  readonly onNativeInterrupt: (result: WaitingForInputResult) => void;
}): Promise<WorkflowGraphUpdate> {
  const result = await runNode(node, state);
  if (result.kind === "waiting_for_input") {
    const waiting = {
      status: "waiting_for_input",
      interrupt_id: result.interrupt_id,
      checkpoint_id: result.checkpoint_id,
      state: result.state
    } satisfies WaitingForInputResult;
    if (node.kind === "interrupt" && useNativeInterrupt) {
      onNativeInterrupt(waiting);
      langGraphInterrupt({
        interrupt_id: result.interrupt_id,
        checkpoint_id: result.checkpoint_id,
        node_id: node.id,
        source: "luna"
      });
    }

    throw new WorkflowWaitingForInput(waiting);
  }

  return result.update;
}

type LangGraphRunNode = (
  node: CompiledWorkflowNode,
  state: LunaRuntimeState
) => Promise<WorkflowNodeAttemptOutcome>;
