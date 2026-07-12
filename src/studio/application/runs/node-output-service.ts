import {
  type RunNodeOutputComparisonResponse,
  RunNodeOutputResponseSchema,
  type RunNodeOutputResponse
} from "../../contracts/run-node-output.js";
import type { RunGraphRunSummary } from "../../contracts/run-graph.js";
import { RunRecordSchema, type RunRecord } from "../../contracts/runs.js";
import type { RunGraphService } from "./graph-service.js";
import {
  StoredRunGraphOutcomeSchema,
  type RunGraphSnapshotReadResult,
  type RunGraphSnapshotStorePort,
  type StoredRunGraphOutcome
} from "./graph-snapshot.js";
import type { RunLedgerPort } from "./ports.js";
import { compareRunNodeOutputs } from "./node-output-comparison.js";

type UnavailableReason = Extract<RunNodeOutputResponse, {
  availability: "unavailable";
}>["reason"];

function unavailableOutput(
  run: RunGraphRunSummary,
  nodeId: string,
  reason: UnavailableReason
): RunNodeOutputResponse {
  return RunNodeOutputResponseSchema.parse({
    schema_version: 1,
    availability: "unavailable",
    run,
    node_id: nodeId,
    reason
  });
}

export class RunNodeOutputReadError extends Error {
  readonly code = "run_node_output_node_not_found";

  constructor() {
    super("Run graph node was not found");
    this.name = "RunNodeOutputReadError";
  }
}

export type RunNodeOutputRead = {
  readonly response: RunNodeOutputResponse;
  readonly record?: RunRecord;
};

async function readOutcomeSafely(
  store: RunGraphSnapshotStorePort,
  handle: string
): Promise<RunGraphSnapshotReadResult<StoredRunGraphOutcome>> {
  try {
    return await store.readOutcome(handle);
  } catch {
    return { kind: "unavailable" };
  }
}

function outcomeMatches(
  outcome: StoredRunGraphOutcome,
  record: RunRecord,
  graphHash: string
): boolean {
  return outcome.identity.run_id === record.run_id &&
    outcome.identity.graph_snapshot_handle === record.graph_snapshot_handle &&
    outcome.identity.workflow_id === record.workflow_id &&
    outcome.identity.workflow_revision === record.workflow_revision &&
    outcome.identity.definition_bundle_hash === record.definition_bundle_hash &&
    outcome.identity.execution_snapshot_hash === record.execution_snapshot_hash &&
    outcome.graph_hash === graphHash &&
    outcome.record_revision === record.record_revision &&
    outcome.run_status === record.run_status;
}

export class RunNodeOutputService {
  readonly #graphs: Pick<RunGraphService, "get">;
  readonly #ledger: RunLedgerPort;
  readonly #store: RunGraphSnapshotStorePort;

  constructor(options: {
    readonly graphs: Pick<RunGraphService, "get">;
    readonly ledger: RunLedgerPort;
    readonly store: RunGraphSnapshotStorePort;
  }) {
    this.#graphs = options.graphs;
    this.#ledger = options.ledger;
    this.#store = options.store;
  }

  async get(runId: string, nodeId: string): Promise<RunNodeOutputResponse> {
    return (await this.getWithRecord(runId, nodeId)).response;
  }

  async compare(
    runId: string,
    nodeId: string,
    baselineRunId: string
  ): Promise<RunNodeOutputComparisonResponse> {
    const [current, baseline] = await Promise.all([
      this.get(runId, nodeId),
      this.get(baselineRunId, nodeId)
    ]);
    return compareRunNodeOutputs({ baseline, current });
  }

  async getWithRecord(
    runId: string,
    nodeId: string
  ): Promise<RunNodeOutputRead> {
    const graph = await this.#graphs.get(runId);
    if (graph.availability !== "available") {
      return {
        response: unavailableOutput(graph.run, nodeId, "graph_unavailable")
      };
    }
    if (!graph.graph.nodes.some((node) => node.id === nodeId)) {
      throw new RunNodeOutputReadError();
    }
    if (
      graph.overlay.observation !== "observed" ||
      graph.overlay.source !== "persisted"
    ) {
      return {
        response: unavailableOutput(graph.run, nodeId, "run_not_terminal")
      };
    }

    const loaded = await this.#ledger.get(runId);
    const record = loaded === undefined ? undefined : RunRecordSchema.parse(loaded);
    const handle = record?.graph_snapshot_handle;
    const result = handle === undefined
      ? { kind: "unavailable" as const }
      : await readOutcomeSafely(this.#store, handle);
    const parsed = result.kind === "available"
      ? StoredRunGraphOutcomeSchema.safeParse(result.value)
      : undefined;
    if (
      record === undefined ||
      parsed === undefined ||
      !parsed.success ||
      !outcomeMatches(parsed.data, record, graph.graph_hash)
    ) {
      return {
        response: unavailableOutput(graph.run, nodeId, "outcome_unavailable"),
        ...(record === undefined ? {} : { record })
      };
    }
    const output = parsed.data.nodes.find((node) => node.node_id === nodeId)
      ?.output_snapshot;
    if (output === undefined) {
      return {
        response: unavailableOutput(graph.run, nodeId, "output_not_recorded"),
        record
      };
    }
    return {
      response: RunNodeOutputResponseSchema.parse({
        schema_version: 1,
        availability: "available",
        run: graph.run,
        node_id: nodeId,
        graph_hash: graph.graph_hash,
        outcome_hash: parsed.data.outcome_hash,
        output
      }),
      record
    };
  }
}
