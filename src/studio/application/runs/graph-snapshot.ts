import { randomBytes } from "node:crypto";
import { z } from "zod";
import { jsonValueBudgetViolation } from "../../../core/json/value.js";
import type { LunaRuntimeState } from "../../../core/runtime/state.js";
import { validateCheckpointState } from "../../../core/runtime/state.js";
import { WorkflowIdSchema } from "../../../core/router/invocation.js";
import type { CompiledWorkflow } from "../../../core/workflow/compiler.js";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import { redactString } from "../../../core/security/redactor.js";
import { StudioDigestSchema } from "../../contracts/digests.js";
import {
  MAX_RUN_GRAPH_NODES,
  MAX_RUN_GRAPH_OBSERVED_FIELDS,
  RunGraphOverlayNodeSchema,
  RunGraphSchema
} from "../../contracts/run-graph.js";
import {
  RunGraphSnapshotHandleSchema,
  RunOpaqueIdSchema,
  RunTerminalStatusSchema
} from "../../contracts/runs.js";
import {
  AvailableRunNodeOutputSnapshotSchema,
  MAX_RUN_OUTPUT_SNAPSHOT_BYTES,
  RunNodeOutputSnapshotSchema,
  STUDIO_RUN_NODE_OUTPUT_LIMITS,
  type RunNodeOutputSnapshot
} from "../../contracts/run-node-output.js";
import { reusableOutputSafety } from "./reusable-output-safety.js";

export const RunGraphSnapshotIdentitySchema = z
  .object({
    graph_snapshot_handle: RunGraphSnapshotHandleSchema,
    run_id: RunOpaqueIdSchema,
    workflow_id: WorkflowIdSchema,
    workflow_revision: StudioDigestSchema,
    definition_bundle_hash: StudioDigestSchema,
    execution_snapshot_hash: StudioDigestSchema
  })
  .strict();
export type RunGraphSnapshotIdentity = z.infer<
  typeof RunGraphSnapshotIdentitySchema
>;

export const RunGraphOutcomeProofSchema = z
  .object({
    identity: RunGraphSnapshotIdentitySchema,
    graph_hash: StudioDigestSchema,
    outcome_hash: StudioDigestSchema,
    record_revision: z.number().int().safe().positive(),
    run_status: RunTerminalStatusSchema
  })
  .strict();
export type RunGraphOutcomeProof = z.infer<
  typeof RunGraphOutcomeProofSchema
>;

const StoredRunGraphSnapshotMaterialSchema = z
  .object({
    schema_version: z.literal(1),
    identity: RunGraphSnapshotIdentitySchema,
    graph: RunGraphSchema
  })
  .strict();

export const StoredRunGraphSnapshotSchema =
  StoredRunGraphSnapshotMaterialSchema.extend({
    graph_hash: StudioDigestSchema
  })
    .strict()
    .superRefine((snapshot, context) => {
      const material = {
        schema_version: snapshot.schema_version,
        identity: snapshot.identity,
        graph: snapshot.graph
      };
      if (snapshot.graph_hash !== sha256Digest(material)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["graph_hash"],
          message: "Stored run graph snapshot failed integrity validation"
        });
      }
    });
export type StoredRunGraphSnapshot = z.infer<
  typeof StoredRunGraphSnapshotSchema
>;

export const StoredRunGraphOutcomeNodeSchema = RunGraphOverlayNodeSchema.extend({
  output_snapshot: RunNodeOutputSnapshotSchema.optional()
}).strict();

const StoredRunGraphOutcomeMaterialSchema = z
  .object({
    schema_version: z.literal(1),
    identity: RunGraphSnapshotIdentitySchema,
    graph_hash: StudioDigestSchema,
    record_revision: z.number().int().safe().positive(),
    run_status: RunTerminalStatusSchema,
    nodes: z.array(StoredRunGraphOutcomeNodeSchema).max(MAX_RUN_GRAPH_NODES)
  })
  .strict();

export const StoredRunGraphOutcomeSchema =
  StoredRunGraphOutcomeMaterialSchema.extend({
    outcome_hash: StudioDigestSchema
  })
  .strict()
  .superRefine((outcome, context) => {
    const ids = new Set<string>();
    for (const [index, node] of outcome.nodes.entries()) {
      if (ids.has(node.node_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", index, "node_id"],
          message: "Stored run graph outcome node ids must be unique"
        });
      }
      ids.add(node.node_id);
    }
    const material = {
      schema_version: outcome.schema_version,
      identity: outcome.identity,
      graph_hash: outcome.graph_hash,
      record_revision: outcome.record_revision,
      run_status: outcome.run_status,
      nodes: outcome.nodes
    };
    if (outcome.outcome_hash !== sha256Digest(material)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome_hash"],
        message: "Stored run graph outcome failed integrity validation"
      });
    }
  });
export type StoredRunGraphOutcome = z.infer<
  typeof StoredRunGraphOutcomeSchema
>;

export function runGraphOutcomeProof(
  input: StoredRunGraphOutcome
): RunGraphOutcomeProof {
  const outcome = StoredRunGraphOutcomeSchema.parse(input);
  return RunGraphOutcomeProofSchema.parse({
    identity: outcome.identity,
    graph_hash: outcome.graph_hash,
    outcome_hash: outcome.outcome_hash,
    record_revision: outcome.record_revision,
    run_status: outcome.run_status
  });
}

export function runGraphOutcomeMatchesProof(
  outcome: StoredRunGraphOutcome,
  proof: RunGraphOutcomeProof
): boolean {
  const parsedOutcome = StoredRunGraphOutcomeSchema.parse(outcome);
  const parsedProof = RunGraphOutcomeProofSchema.parse(proof);
  return sha256Digest(runGraphOutcomeProof(parsedOutcome)) ===
    sha256Digest(parsedProof);
}

export type RunGraphSnapshotReadResult<T> =
  | { readonly kind: "available"; readonly value: T }
  | { readonly kind: "missing" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "unavailable" };

export interface RunGraphSnapshotStorePort {
  initialize(): Promise<void>;
  writeGraph(snapshot: StoredRunGraphSnapshot): Promise<void>;
  writeOutcome(outcome: StoredRunGraphOutcome): Promise<void>;
  readGraph(
    handle: string
  ): Promise<RunGraphSnapshotReadResult<StoredRunGraphSnapshot>>;
  readOutcome(
    handle: string
  ): Promise<RunGraphSnapshotReadResult<StoredRunGraphOutcome>>;
}

export function runGraphSnapshotIdentitiesEqual(
  left: RunGraphSnapshotIdentity,
  right: RunGraphSnapshotIdentity
): boolean {
  return (
    left.graph_snapshot_handle === right.graph_snapshot_handle &&
    left.run_id === right.run_id &&
    left.workflow_id === right.workflow_id &&
    left.workflow_revision === right.workflow_revision &&
    left.definition_bundle_hash === right.definition_bundle_hash &&
    left.execution_snapshot_hash === right.execution_snapshot_hash
  );
}

export type RunGraphSnapshotErrorCode =
  | "run_graph_identity_mismatch"
  | "run_graph_projection_invalid"
  | "run_graph_store_write_failed";

export class RunGraphSnapshotError extends Error {
  readonly code: RunGraphSnapshotErrorCode;

  constructor(code: RunGraphSnapshotErrorCode, message: string) {
    super(message);
    this.name = "RunGraphSnapshotError";
    this.code = code;
  }
}

function projectionError(message: string): RunGraphSnapshotError {
  return new RunGraphSnapshotError("run_graph_projection_invalid", message);
}

function projectGraphEdges(compiled: CompiledWorkflow) {
  const nodeIds = new Set(compiled.nodes.map((node) => node.id));
  return compiled.edges.flatMap((edge) => {
    const fromNode = nodeIds.has(edge.from);
    const toNode = nodeIds.has(edge.to);
    if (fromNode && toNode) {
      return [{ from: edge.from, to: edge.to }];
    }
    if (
      (edge.from === "__start__" && toNode) ||
      (fromNode && edge.to === "__end__")
    ) {
      return [];
    }
    throw projectionError(
      "Compiled workflow edge references an unknown graph endpoint"
    );
  });
}

export function createRunGraphSnapshotHandle(
  entropySource: (size: number) => Uint8Array = (size) => randomBytes(size)
): string {
  const entropy = entropySource(24);
  if (entropy.byteLength !== 24) {
    throw projectionError("Run graph handle entropy must contain exactly 24 bytes");
  }
  return RunGraphSnapshotHandleSchema.parse(
    `gs_${Buffer.from(entropy).toString("base64url")}`
  );
}

export function projectStoredRunGraphSnapshot(input: {
  readonly identity: RunGraphSnapshotIdentity;
  readonly compiled: CompiledWorkflow;
}): StoredRunGraphSnapshot {
  const identity = RunGraphSnapshotIdentitySchema.parse(input.identity);
  if (
    input.compiled.workflow_id !== identity.workflow_id ||
    input.compiled.workflow_revision !== identity.workflow_revision
  ) {
    throw new RunGraphSnapshotError(
      "run_graph_identity_mismatch",
      "Compiled workflow does not match the pinned run identity"
    );
  }

  const graph = RunGraphSchema.parse({
    state_schema_version: input.compiled.state_schema_version,
    nodes: input.compiled.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      capability_id: node.capability_id,
      can_create_pending_interrupt: node.can_create_pending_interrupt
    })),
    edges: projectGraphEdges(input.compiled)
  });
  const material = StoredRunGraphSnapshotMaterialSchema.parse({
    schema_version: 1,
    identity,
    graph
  });
  return StoredRunGraphSnapshotSchema.parse({
    ...material,
    graph_hash: sha256Digest(material)
  });
}

function assertRuntimeIdentity(
  identity: RunGraphSnapshotIdentity,
  state: LunaRuntimeState
): void {
  if (
    state.run.run_id !== identity.run_id ||
    state.run.workflow_id !== identity.workflow_id ||
    state.workflow.id !== identity.workflow_id
  ) {
    throw new RunGraphSnapshotError(
      "run_graph_identity_mismatch",
      "Runtime state does not match the pinned run identity"
    );
  }
}

function projectOutcomeNodes(
  graph: StoredRunGraphSnapshot["graph"],
  state: LunaRuntimeState
): StoredRunGraphOutcome["nodes"] {
  const graphIds = new Set(graph.nodes.map((node) => node.id));
  for (const nodeId of Object.keys(state.node_statuses)) {
    if (!graphIds.has(nodeId)) {
      throw projectionError("Runtime outcome references an unknown graph node");
    }
  }
  for (const nodeId of Object.keys(state.attempts)) {
    if (!graphIds.has(nodeId) || state.node_statuses[nodeId] === undefined) {
      throw projectionError("Runtime attempts lack an observable graph node status");
    }
  }

  let capturedOutputBytes = 0;
  return graph.nodes.flatMap((graphNode) => {
    const status = state.node_statuses[graphNode.id];
    if (status === undefined) {
      return [];
    }
    const attempts = state.attempts[graphNode.id];
    if (
      status.attempt !== undefined &&
      (attempts === undefined || status.attempt !== attempts.count)
    ) {
      throw projectionError("Runtime node attempt count is inconsistent");
    }
    const output = state.steps[graphNode.id] === undefined
      ? undefined
      : reusableOutputSnapshot(state.steps[graphNode.id]);
    const outputSnapshot = output === undefined
      ? undefined
      : output.bytes + capturedOutputBytes > MAX_RUN_OUTPUT_SNAPSHOT_BYTES
        ? {
            availability: "unavailable" as const,
            reason: "snapshot_budget_exhausted" as const
          }
        : output.snapshot;
    if (output?.snapshot.availability === "available" &&
      outputSnapshot?.availability === "available") {
      capturedOutputBytes += output.bytes;
    }
    return [
      StoredRunGraphOutcomeNodeSchema.parse({
        node_id: graphNode.id,
        status: status.status,
        ...(attempts === undefined ? {} : { attempt_count: attempts.count }),
        ...(state.steps[graphNode.id] === undefined
          ? {}
          : {
              observed_output: observedOutputShape(state.steps[graphNode.id]),
              output_snapshot: outputSnapshot
            })
      })
    ];
  });
}

function reusableOutputSnapshot(value: unknown): {
  readonly snapshot: RunNodeOutputSnapshot;
  readonly bytes: number;
} {
  if (
    jsonValueBudgetViolation(value, STUDIO_RUN_NODE_OUTPUT_LIMITS) !==
    undefined
  ) {
    return {
      snapshot: { availability: "unavailable", reason: "value_limit_exceeded" },
      bytes: 0
    };
  }
  const sanitized = reusableOutputSafety(value);
  const snapshot = AvailableRunNodeOutputSnapshotSchema.parse({
    availability: "available",
    value: sanitized.value,
    redaction: {
      mode: "best_effort",
      changed: sanitized.changed
    }
  });
  return {
    snapshot,
    bytes: Buffer.byteLength(JSON.stringify(snapshot.value), "utf8")
  };
}

function observedValueType(value: unknown):
  "null" | "boolean" | "number" | "string" | "object" | "array" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value as "boolean" | "number" | "string";
}

function observedOutputShape(value: unknown) {
  const fields: Array<{
    readonly path: string[];
    readonly value_type: ReturnType<typeof observedValueType>;
  }> = [];
  const pending: Array<{ readonly path: string[]; readonly value: unknown }> = [
    { path: [], value }
  ];
  let nextPending = 0;
  let truncated = false;
  const enqueue = (entry: { readonly path: string[]; readonly value: unknown }) => {
    if (pending.length >= MAX_RUN_GRAPH_OBSERVED_FIELDS) {
      truncated = true;
      return;
    }
    pending.push(entry);
  };
  while (nextPending < pending.length) {
    const current = pending[nextPending];
    nextPending += 1;
    if (current === undefined) break;
    if (fields.length >= MAX_RUN_GRAPH_OBSERVED_FIELDS) {
      truncated = true;
      break;
    }
    fields.push({
      path: current.path,
      value_type: observedValueType(current.value)
    });
    if (current.path.length >= 16) {
      if (typeof current.value === "object" && current.value !== null) {
        truncated = true;
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value[0] !== undefined) {
        enqueue({ path: [...current.path, "*"], value: current.value[0] });
      }
    } else if (typeof current.value === "object" && current.value !== null) {
      for (const [key, nested] of Object.entries(current.value)) {
        const boundedKey = key.length === 0 ? "<empty>" : key.slice(0, 128);
        enqueue({
          path: [...current.path, redactString(boundedKey) === boundedKey ? boundedKey : "<redacted>"],
          value: nested
        });
      }
    }
  }
  return { redaction: "values_removed" as const, truncated, fields };
}

export function projectStoredRunGraphOutcome(input: {
  readonly graphSnapshot: StoredRunGraphSnapshot;
  readonly recordRevision: number;
  readonly state: LunaRuntimeState;
}): StoredRunGraphOutcome {
  const graphSnapshot = StoredRunGraphSnapshotSchema.parse(input.graphSnapshot);
  validateCheckpointState(input.state);
  assertRuntimeIdentity(graphSnapshot.identity, input.state);
  const material = StoredRunGraphOutcomeMaterialSchema.parse({
    schema_version: 1,
    identity: graphSnapshot.identity,
    graph_hash: graphSnapshot.graph_hash,
    record_revision: input.recordRevision,
    run_status: input.state.run_status,
    nodes: projectOutcomeNodes(graphSnapshot.graph, input.state)
  });
  return StoredRunGraphOutcomeSchema.parse({
    ...material,
    outcome_hash: sha256Digest(material)
  });
}
