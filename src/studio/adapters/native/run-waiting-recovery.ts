import {
  waitingBoundaryNodeIdentity,
  type WaitingBoundaryWorkflowIdentity
} from "../../../runtime/workflow/resume-origin.js";
import type { StoredRunGraphSnapshot } from "../../application/runs/graph-snapshot.js";

/** Projects the immutable Studio graph into the minimum durable wait identity. */
export function nativeStudioWaitingWorkflowIdentity(
  snapshot: StoredRunGraphSnapshot,
  mode: WaitingBoundaryWorkflowIdentity["mode"]
): WaitingBoundaryWorkflowIdentity {
  return {
    id: snapshot.identity.workflow_id,
    revision: snapshot.identity.workflow_revision,
    mode,
    state_schema_version: snapshot.graph.state_schema_version,
    nodes: snapshot.graph.nodes.map(waitingBoundaryNodeIdentity)
  };
}
