import { Annotation } from "@langchain/langgraph";
import type { JsonValue } from "../../core/runtime/json.js";
import type { RunHandle } from "../../core/runtime/run-handle.js";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import type { WorkflowNodeRunUpdate } from "../workflow/node-runner.js";

export const WorkflowStateAnnotation = Annotation.Root({
  state_schema_version: Annotation<LunaRuntimeState["state_schema_version"]>(),
  invocation: Annotation<JsonValue>(),
  config: Annotation<JsonValue>(),
  run: Annotation<RunHandle>(),
  workflow: Annotation<LunaRuntimeState["workflow"]>(),
  run_status: Annotation<LunaRuntimeState["run_status"]>(),
  node_statuses: Annotation<
    LunaRuntimeState["node_statuses"],
    LunaRuntimeState["node_statuses"]
  >({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({})
  }),
  steps: Annotation<LunaRuntimeState["steps"], LunaRuntimeState["steps"]>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({})
  }),
  attempts: Annotation<LunaRuntimeState["attempts"], LunaRuntimeState["attempts"]>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({})
  }),
  artifact_refs: Annotation<
    LunaRuntimeState["artifact_refs"],
    LunaRuntimeState["artifact_refs"]
  >({
    reducer: (left, right) => [...left, ...right],
    default: () => []
  }),
  interrupt_refs: Annotation<
    LunaRuntimeState["interrupt_refs"],
    LunaRuntimeState["interrupt_refs"]
  >({
    reducer: (left, right) => [...left, ...right],
    default: () => []
  }),
  event_cursor: Annotation<LunaRuntimeState["event_cursor"]>(),
  primary_failure: Annotation<LunaRuntimeState["primary_failure"]>()
});

export type WorkflowGraphState = typeof WorkflowStateAnnotation.State;
export type WorkflowGraphUpdate = typeof WorkflowStateAnnotation.Update;

/**
 * Applies one completed node update with the same reducers used by LangGraph.
 * Keeping this projection local to the scheduler lets Luna retain completed
 * sibling branches even when LangGraph rejects a parallel superstep.
 */
export function applyWorkflowGraphUpdate(
  state: LunaRuntimeState,
  update: WorkflowNodeRunUpdate
): LunaRuntimeState {
  return {
    ...state,
    ...update,
    node_statuses: {
      ...state.node_statuses,
      ...(update.node_statuses ?? {})
    },
    steps: {
      ...state.steps,
      ...(update.steps ?? {})
    },
    attempts: {
      ...state.attempts,
      ...(update.attempts ?? {})
    },
    artifact_refs: [
      ...state.artifact_refs,
      ...(update.artifact_refs ?? [])
    ]
  };
}
