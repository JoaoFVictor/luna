import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";

export type WorkflowRuntimeStreamEvent =
  | {
      readonly kind: "update";
      readonly nodeIds: readonly string[];
    }
  | {
      readonly kind: "checkpoint";
      readonly checkpointId?: string;
      readonly nextNodeIds: readonly string[];
    }
  | {
      readonly kind: "task";
      readonly taskId?: string;
      readonly nodeId?: string;
      readonly phase: "started" | "finished";
      readonly interruptCount: number;
    }
  | {
      readonly kind: "runtime_event";
      readonly channel: string;
      readonly nodeId?: string;
      readonly namespace: readonly string[];
    };

export async function appendWorkflowRuntimeStreamLog(
  input: RunWorkflowInput,
  event: WorkflowRuntimeStreamEvent
): Promise<void> {
  await input.observability?.recorder.addEvent("runtime.stream", {
    kind: event.kind,
    ...structuredEventData(event)
  });
}

function structuredEventData(event: WorkflowRuntimeStreamEvent): Record<string, unknown> {
  if (event.kind === "update") {
    return { node_ids: event.nodeIds };
  }

  if (event.kind === "runtime_event") {
    return {
      channel: event.channel,
      node_id: event.nodeId,
      namespace: event.namespace
    };
  }

  if (event.kind === "checkpoint") {
    return {
      checkpoint_id: event.checkpointId,
      next_node_ids: event.nextNodeIds
    };
  }

  return {
    task_id: event.taskId,
    node_id: event.nodeId,
    phase: event.phase,
    interrupt_count: event.interruptCount
  };
}
