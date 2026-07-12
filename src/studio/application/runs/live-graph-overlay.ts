import { z } from "zod";
import type {
  RunGraph,
  RunGraphOverlayNode
} from "../../contracts/run-graph.js";
import type { RunEvent, RunRecord } from "../../contracts/runs.js";
import { NodeLifecycleObservedEventSchema } from "./ports.js";

const NodeLifecycleEventDataSchema = z.object({
  node_event: NodeLifecycleObservedEventSchema
}).passthrough();

const statusByEvent = {
  "node.started": "running",
  "node.succeeded": "succeeded",
  "node.failed": "failed"
} as const;

export type LiveRunGraphHistory = "complete" | "recent" | "active_only";

export type LiveRunGraphProjection = {
  readonly history: LiveRunGraphHistory;
  readonly nodes: RunGraphOverlayNode[];
};

export function projectLiveRunGraph(input: {
  readonly record: RunRecord;
  readonly graph: RunGraph;
  readonly events: readonly RunEvent[];
  readonly history: LiveRunGraphHistory;
}): LiveRunGraphProjection | undefined {
  const graphIds = new Set(input.graph.nodes.map((node) => node.id));
  if (input.record.active_node_ids.some((nodeId) => !graphIds.has(nodeId))) {
    return undefined;
  }

  const observed = new Map<string, RunGraphOverlayNode>();
  for (const event of input.events) {
    if (event.record_revision === undefined ||
      event.record_revision > input.record.record_revision) {
      continue;
    }
    const parsed = NodeLifecycleEventDataSchema.safeParse(event.data);
    if (!parsed.success) return undefined;
    const nodeEvent = parsed.data.node_event;
    if (
      event.event_type !== `run.${nodeEvent.type}` ||
      !graphIds.has(nodeEvent.node_id)
    ) {
      return undefined;
    }
    if (!observed.has(nodeEvent.node_id)) {
      observed.set(nodeEvent.node_id, {
        node_id: nodeEvent.node_id,
        status: statusByEvent[nodeEvent.type],
        attempt_count: nodeEvent.attempt
      });
    }
  }

  for (const nodeId of input.record.active_node_ids) {
    const attemptCount = observed.get(nodeId)?.attempt_count;
    observed.set(nodeId, {
      node_id: nodeId,
      status: input.record.run_status === "waiting_for_input"
        ? "waiting_for_input"
        : "running",
      ...(attemptCount === undefined
        ? {}
        : { attempt_count: attemptCount })
    });
  }

  return {
    history: input.history,
    nodes: input.graph.nodes.flatMap((node) => {
      const projection = observed.get(node.id);
      return projection === undefined ? [] : [projection];
    })
  };
}
