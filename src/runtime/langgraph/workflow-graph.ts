import { StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import {
  WorkflowStateAnnotation,
  type WorkflowGraphState,
  type WorkflowGraphUpdate
} from "./workflow-state.js";
import {
  groupLangGraphEdges,
  langGraphEdges
} from "./workflow-edges.js";
import type { RunCompiledWorkflowInput } from "./workflow-runner-types.js";

type DynamicStateGraph = {
  addNode(
    key: string,
    action: (state: WorkflowGraphState) => Promise<WorkflowGraphUpdate>
  ): void;
  addEdge(from: string | string[], to: string): void;
  compile(options: {
    readonly name: string;
    readonly checkpointer?: BaseCheckpointSaver;
  }): {
    streamEvents(
      state: LunaRuntimeState,
      options: {
        readonly configurable: { readonly thread_id: string };
        readonly version: "v3";
        readonly streamMode: readonly ["updates", "values", "checkpoints", "tasks"];
        readonly durability?: "sync";
      }
    ): Promise<AsyncIterable<unknown> & {
      readonly output: Promise<unknown>;
      readonly interrupted: boolean;
      readonly interrupts: readonly unknown[];
    }>;
  };
};

export function compileLangGraphWorkflow({
  input,
  nodes,
  startIndex,
  deferredFinalReportIds,
  runNode
}: {
  readonly input: RunCompiledWorkflowInput;
  readonly nodes: readonly CompiledWorkflowNode[];
  readonly startIndex: number;
  readonly deferredFinalReportIds: ReadonlySet<string>;
  readonly runNode: (
    node: CompiledWorkflowNode,
    state: WorkflowGraphState
  ) => Promise<WorkflowGraphUpdate>;
}) {
  const graph = new StateGraph(WorkflowStateAnnotation) as unknown as DynamicStateGraph;

  for (const node of nodes) {
    graph.addNode(node.id, async (state) => await runNode(node, state));
  }

  for (const edge of groupLangGraphEdges(
    langGraphEdges(input, nodes, startIndex, deferredFinalReportIds)
  )) {
    graph.addEdge(edge.from, edge.to);
  }

  return graph.compile({
    name: input.workflow.id,
    ...(input.langGraphCheckpointer === undefined
      ? {}
      : { checkpointer: input.langGraphCheckpointer })
  });
}
