import {
  RunGraphResponseSchema,
  type RunGraphOverlay,
  type RunGraphResponse,
  type RunGraphRunSummary
} from "../../contracts/run-graph.js";
import {
  RunOpaqueIdSchema,
  RunRecordSchema,
  RunTerminalStatusSchema,
  type RunRecord
} from "../../contracts/runs.js";
import type { RunLedgerPort } from "./ports.js";
import {
  StoredRunGraphOutcomeSchema,
  StoredRunGraphSnapshotSchema,
  runGraphSnapshotIdentitiesEqual,
  type RunGraphSnapshotReadResult,
  type RunGraphSnapshotStorePort,
  type StoredRunGraphOutcome,
  type StoredRunGraphSnapshot
} from "./graph-snapshot.js";

export class RunGraphReadError extends Error {
  readonly code: "run_graph_run_id_invalid" | "run_graph_run_not_found";

  constructor(
    code: "run_graph_run_id_invalid" | "run_graph_run_not_found",
    message: string
  ) {
    super(message);
    this.name = "RunGraphReadError";
    this.code = code;
  }
}

function runSummary(record: RunRecord): RunGraphRunSummary {
  return {
    run_id: record.run_id,
    workflow_id: record.workflow_id,
    ...(record.workflow_revision === undefined
      ? {}
      : { workflow_revision: record.workflow_revision }),
    ...(record.definition_bundle_hash === undefined
      ? {}
      : { definition_bundle_hash: record.definition_bundle_hash }),
    ...(record.execution_snapshot_hash === undefined
      ? {}
      : { execution_snapshot_hash: record.execution_snapshot_hash }),
    status: record.run_status ?? record.dispatch_status,
    completeness: record.completeness
  };
}

function exactIdentityAvailable(record: RunRecord): boolean {
  return (
    record.workflow_revision !== undefined &&
    record.definition_bundle_hash !== undefined &&
    record.execution_snapshot_hash !== undefined
  );
}

function graphIdentityMatches(
  record: RunRecord,
  snapshot: StoredRunGraphSnapshot
): boolean {
  return (
    snapshot.identity.graph_snapshot_handle === record.graph_snapshot_handle &&
    snapshot.identity.run_id === record.run_id &&
    snapshot.identity.workflow_id === record.workflow_id &&
    snapshot.identity.workflow_revision === record.workflow_revision &&
    snapshot.identity.definition_bundle_hash === record.definition_bundle_hash &&
    snapshot.identity.execution_snapshot_hash === record.execution_snapshot_hash
  );
}

function outcomeCompatibility(
  record: RunRecord,
  graph: StoredRunGraphSnapshot,
  outcome: StoredRunGraphOutcome
): "compatible" | "corrupt" | "stale" {
  if (
    outcome.graph_hash !== graph.graph_hash ||
    !runGraphSnapshotIdentitiesEqual(outcome.identity, graph.identity)
  ) {
    return "corrupt";
  }
  const graphIds = new Set(graph.graph.nodes.map((node) => node.id));
  if (outcome.nodes.some((node) => !graphIds.has(node.node_id))) {
    return "corrupt";
  }
  if (
    outcome.record_revision !== record.record_revision ||
    outcome.run_status !== record.run_status
  ) {
    return "stale";
  }
  return "compatible";
}

function unobservable(reason: Extract<RunGraphOverlay, {
  observation: "unobservable";
}>["reason"]): RunGraphOverlay {
  return { observation: "unobservable", reason };
}

async function safeRead<T>(
  read: () => Promise<RunGraphSnapshotReadResult<T>>
): Promise<RunGraphSnapshotReadResult<T>> {
  try {
    return await read();
  } catch {
    return { kind: "unavailable" };
  }
}

export type RunGraphServiceOptions = {
  readonly ledger: RunLedgerPort;
  readonly store: RunGraphSnapshotStorePort;
};

export class RunGraphService {
  readonly #ledger: RunLedgerPort;
  readonly #store: RunGraphSnapshotStorePort;

  constructor(options: RunGraphServiceOptions) {
    this.#ledger = options.ledger;
    this.#store = options.store;
  }

  async get(runId: string): Promise<RunGraphResponse> {
    const parsedRunId = RunOpaqueIdSchema.safeParse(runId);
    if (!parsedRunId.success) {
      throw new RunGraphReadError(
        "run_graph_run_id_invalid",
        "Run id is invalid"
      );
    }
    const loaded = await this.#ledger.get(parsedRunId.data);
    if (loaded === undefined) {
      throw new RunGraphReadError(
        "run_graph_run_not_found",
        "Run was not found"
      );
    }
    const record = RunRecordSchema.parse(loaded);
    const run = runSummary(record);

    if (record.completeness === "legacy") {
      return RunGraphResponseSchema.parse({
        schema_version: 1,
        availability: "legacy",
        reason: "legacy_run_without_snapshot",
        run
      });
    }
    if (record.completeness === "partial") {
      return RunGraphResponseSchema.parse({
        schema_version: 1,
        availability: "unavailable",
        reason: "partial_run_without_snapshot",
        run
      });
    }
    if (record.dispatch_status === "rejected") {
      return RunGraphResponseSchema.parse({
        schema_version: 1,
        availability: "unavailable",
        reason: "run_not_executed",
        run
      });
    }

    const graphSnapshotHandle = record.graph_snapshot_handle;
    if (graphSnapshotHandle === undefined) {
      return RunGraphResponseSchema.parse({
        schema_version: 1,
        availability: "unavailable",
        reason: "graph_snapshot_not_preallocated",
        run
      });
    }

    if (!exactIdentityAvailable(record)) {
      return RunGraphResponseSchema.parse({
        schema_version: 1,
        availability: "unavailable",
        reason: "run_identity_incomplete",
        run
      });
    }

    const graphResult = await safeRead(() =>
      this.#store.readGraph(graphSnapshotHandle)
    );
    if (graphResult.kind === "missing") {
      const stillExecuting =
        !RunTerminalStatusSchema.safeParse(record.run_status).success;
      return RunGraphResponseSchema.parse({
        schema_version: 1,
        availability: stillExecuting ? "pending" : "unavailable",
        reason: stillExecuting
          ? "graph_not_persisted_yet"
          : "graph_missing_after_completion",
        run
      });
    }
    if (graphResult.kind === "corrupt") {
      return RunGraphResponseSchema.parse({
        schema_version: 1,
        availability: "corrupt",
        reason: "graph_snapshot_invalid",
        run
      });
    }
    if (graphResult.kind === "unavailable") {
      return RunGraphResponseSchema.parse({
        schema_version: 1,
        availability: "unavailable",
        reason: "graph_snapshot_unavailable",
        run
      });
    }

    const parsedGraph = StoredRunGraphSnapshotSchema.safeParse(graphResult.value);
    if (!parsedGraph.success) {
      return RunGraphResponseSchema.parse({
        schema_version: 1,
        availability: "corrupt",
        reason: "graph_snapshot_invalid",
        run
      });
    }
    const graph = parsedGraph.data;
    if (!graphIdentityMatches(record, graph)) {
      return RunGraphResponseSchema.parse({
        schema_version: 1,
        availability: "corrupt",
        reason: "graph_snapshot_identity_mismatch",
        run
      });
    }

    const overlay = await this.overlay(record, graph, graphSnapshotHandle);
    return RunGraphResponseSchema.parse({
      schema_version: 1,
      availability: "available",
      run,
      graph_hash: graph.graph_hash,
      graph: graph.graph,
      overlay
    });
  }

  private async overlay(
    record: RunRecord,
    graph: StoredRunGraphSnapshot,
    graphSnapshotHandle: string
  ): Promise<RunGraphOverlay> {
    if (record.dispatch_status !== "started" || record.run_status === undefined) {
      return unobservable("run_not_started");
    }
    if (!RunTerminalStatusSchema.safeParse(record.run_status).success) {
      if (record.lifecycle_projection === "degraded") {
        return unobservable("live_projection_invalid");
      }
      const graphIds = new Set(graph.graph.nodes.map((node) => node.id));
      if (record.active_node_ids.some((nodeId) => !graphIds.has(nodeId))) {
        return unobservable("live_projection_invalid");
      }
      return {
        observation: "observed",
        source: "live",
        record_revision: record.record_revision,
        run_status: record.run_status,
        nodes: record.active_node_ids.map((nodeId) => ({
          node_id: nodeId,
          status: record.run_status === "waiting_for_input"
            ? "waiting_for_input" as const
            : "running" as const
        }))
      };
    }

    const result = await safeRead(() =>
      this.#store.readOutcome(graphSnapshotHandle)
    );
    if (result.kind !== "available") {
      return unobservable(
        result.kind === "missing"
          ? "outcome_missing"
          : result.kind === "corrupt"
            ? "outcome_corrupt"
            : "outcome_unavailable"
      );
    }
    const parsedOutcome = StoredRunGraphOutcomeSchema.safeParse(result.value);
    if (!parsedOutcome.success) {
      return unobservable("outcome_corrupt");
    }
    const compatibility = outcomeCompatibility(record, graph, parsedOutcome.data);
    if (compatibility !== "compatible") {
      return unobservable(
        compatibility === "corrupt" ? "outcome_corrupt" : "outcome_stale"
      );
    }
    return {
      observation: "observed",
      source: "persisted",
      record_revision: parsedOutcome.data.record_revision,
      run_status: parsedOutcome.data.run_status,
      nodes: parsedOutcome.data.nodes
    };
  }
}
