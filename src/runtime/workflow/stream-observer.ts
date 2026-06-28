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
  if (!input.workflow.observability.exporters.runtime_log.enabled) {
    return;
  }

  await input.backends.runtimeLogs.append({
    run_id: input.run.run_id,
    timestamp: new Date().toISOString(),
    level: "debug",
    node_id: primaryNodeId(event),
    message: messageFor(event)
  });
}

function primaryNodeId(event: WorkflowRuntimeStreamEvent): string | undefined {
  if (event.kind === "update") {
    return event.nodeIds[0];
  }
  if (event.kind === "task") {
    return event.nodeId;
  }
  if (event.kind === "runtime_event") {
    return event.nodeId;
  }
  return event.nextNodeIds[0];
}

function messageFor(event: WorkflowRuntimeStreamEvent): string {
  if (event.kind === "update") {
    return `workflow runtime stream update: ${event.nodeIds.join(",") || "unknown"}`;
  }

  if (event.kind === "runtime_event") {
    const namespace = event.namespace.join("/") || "root";
    return `workflow runtime stream event: ${event.channel}; namespace=${namespace}`;
  }

  if (event.kind === "checkpoint") {
    const checkpoint = event.checkpointId ?? "unknown";
    const next = event.nextNodeIds.join(",") || "none";
    return `workflow runtime stream checkpoint: ${checkpoint}; next=${next}`;
  }

  const task = event.taskId ?? "unknown";
  const node = event.nodeId ?? "unknown";
  return `workflow runtime stream task ${event.phase}: ${node}; task=${task}; interrupts=${event.interruptCount}`;
}
