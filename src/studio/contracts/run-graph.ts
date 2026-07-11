import { z } from "zod";
import { WorkflowIdSchema } from "../../core/router/invocation.js";
import { StudioDigestSchema } from "./digests.js";
import {
  RunCompletenessSchema,
  RunDisplayStatusSchema,
  RunOpaqueIdSchema,
  RunRuntimeStatusSchema
} from "./runs.js";

export const MAX_RUN_GRAPH_NODES = 10_000;
export const MAX_RUN_GRAPH_EDGES = 50_000;
export const MAX_RUN_GRAPH_OBSERVED_FIELDS = 256;

const BoundedIdSchema = z.string().trim().min(1).max(256);

export const RunGraphNodeStatusSchema = z.enum([
  "pending",
  "running",
  "waiting_for_input",
  "succeeded",
  "failed",
  "skipped_inactive",
  "skipped_dependency_failed",
  "cancelled",
  "timed_out"
]);
export type RunGraphNodeStatus = z.infer<typeof RunGraphNodeStatusSchema>;

export const RunGraphNodeSchema = z
  .object({
    id: BoundedIdSchema,
    kind: z.enum(["built_in", "agent", "pattern", "interrupt"]),
    capability_id: BoundedIdSchema,
    can_create_pending_interrupt: z.boolean()
  })
  .strict();
export type RunGraphNode = z.infer<typeof RunGraphNodeSchema>;

export const RunGraphEdgeSchema = z
  .object({
    from: BoundedIdSchema,
    to: BoundedIdSchema
  })
  .strict();
export type RunGraphEdge = z.infer<typeof RunGraphEdgeSchema>;

export const RunGraphSchema = z
  .object({
    state_schema_version: z.string().trim().min(1).max(128),
    nodes: z.array(RunGraphNodeSchema).min(1).max(MAX_RUN_GRAPH_NODES),
    edges: z.array(RunGraphEdgeSchema).max(MAX_RUN_GRAPH_EDGES)
  })
  .strict()
  .superRefine((graph, context) => {
    const nodeIds = new Set<string>();
    for (const [index, node] of graph.nodes.entries()) {
      if (nodeIds.has(node.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", index, "id"],
          message: "Run graph node ids must be unique"
        });
      }
      nodeIds.add(node.id);
    }

    const edges = new Set<string>();
    for (const [index, edge] of graph.edges.entries()) {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index],
          message: "Run graph edges must reference projected nodes"
        });
      }
      const key = `${edge.from}\u0000${edge.to}`;
      if (edges.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index],
          message: "Run graph edges must be unique"
        });
      }
      edges.add(key);
    }
  });
export type RunGraph = z.infer<typeof RunGraphSchema>;

export const RunGraphOverlayNodeSchema = z
  .object({
    node_id: BoundedIdSchema,
    status: RunGraphNodeStatusSchema,
    attempt_count: z.number().int().safe().nonnegative().optional(),
    observed_output: z.object({
      redaction: z.literal("values_removed"),
      truncated: z.boolean(),
      fields: z.array(z.object({
        path: z.array(z.string().min(1).max(128)).max(16),
        value_type: z.enum(["null", "boolean", "number", "string", "object", "array"])
      }).strict()).max(MAX_RUN_GRAPH_OBSERVED_FIELDS)
    }).strict().optional()
  })
  .strict();
export type RunGraphOverlayNode = z.infer<typeof RunGraphOverlayNodeSchema>;

const ObservedRunGraphOverlaySchema = z
  .object({
    observation: z.literal("observed"),
    source: z.enum(["live", "persisted"]),
    record_revision: z.number().int().safe().positive(),
    run_status: RunRuntimeStatusSchema,
    nodes: z.array(RunGraphOverlayNodeSchema).max(MAX_RUN_GRAPH_NODES)
  })
  .strict()
  .superRefine((overlay, context) => {
    const ids = new Set<string>();
    for (const [index, node] of overlay.nodes.entries()) {
      if (ids.has(node.node_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", index, "node_id"],
          message: "Observed run graph node ids must be unique"
        });
      }
      ids.add(node.node_id);
    }
  });

const UnobservableRunGraphOverlaySchema = z
  .object({
    observation: z.literal("unobservable"),
    reason: z.enum([
      "run_not_started",
      "live_observer_unavailable",
      "live_projection_invalid",
      "outcome_missing",
      "outcome_corrupt",
      "outcome_unavailable",
      "outcome_stale"
    ])
  })
  .strict();

export const RunGraphOverlaySchema = z.union([
  ObservedRunGraphOverlaySchema,
  UnobservableRunGraphOverlaySchema
]);
export type RunGraphOverlay = z.infer<typeof RunGraphOverlaySchema>;

export const RunGraphRunSummarySchema = z
  .object({
    run_id: RunOpaqueIdSchema,
    workflow_id: WorkflowIdSchema,
    workflow_revision: StudioDigestSchema.optional(),
    definition_bundle_hash: StudioDigestSchema.optional(),
    execution_snapshot_hash: StudioDigestSchema.optional(),
    status: RunDisplayStatusSchema,
    completeness: RunCompletenessSchema
  })
  .strict();
export type RunGraphRunSummary = z.infer<typeof RunGraphRunSummarySchema>;

const ExactRunGraphRunSummarySchema = RunGraphRunSummarySchema.extend({
  workflow_revision: StudioDigestSchema,
  definition_bundle_hash: StudioDigestSchema,
  execution_snapshot_hash: StudioDigestSchema
}).strict();

const AvailableRunGraphResponseSchema = z
  .object({
    schema_version: z.literal(1),
    availability: z.literal("available"),
    run: ExactRunGraphRunSummarySchema,
    graph_hash: StudioDigestSchema,
    graph: RunGraphSchema,
    overlay: RunGraphOverlaySchema
  })
  .strict();

const PendingRunGraphResponseSchema = z
  .object({
    schema_version: z.literal(1),
    availability: z.literal("pending"),
    reason: z.literal("graph_not_persisted_yet"),
    run: RunGraphRunSummarySchema
  })
  .strict();

const LegacyRunGraphResponseSchema = z
  .object({
    schema_version: z.literal(1),
    availability: z.literal("legacy"),
    reason: z.literal("legacy_run_without_snapshot"),
    run: RunGraphRunSummarySchema
  })
  .strict();

const UnavailableRunGraphResponseSchema = z
  .object({
    schema_version: z.literal(1),
    availability: z.literal("unavailable"),
    reason: z.enum([
      "partial_run_without_snapshot",
      "graph_snapshot_not_preallocated",
      "graph_missing_after_completion",
      "run_not_executed",
      "run_identity_incomplete",
      "graph_snapshot_unavailable"
    ]),
    run: RunGraphRunSummarySchema
  })
  .strict();

const CorruptRunGraphResponseSchema = z
  .object({
    schema_version: z.literal(1),
    availability: z.literal("corrupt"),
    reason: z.enum([
      "graph_snapshot_invalid",
      "graph_snapshot_identity_mismatch"
    ]),
    run: RunGraphRunSummarySchema
  })
  .strict();

export const RunGraphResponseSchema = z.union([
  AvailableRunGraphResponseSchema,
  PendingRunGraphResponseSchema,
  LegacyRunGraphResponseSchema,
  UnavailableRunGraphResponseSchema,
  CorruptRunGraphResponseSchema
]);
export type RunGraphResponse = z.infer<typeof RunGraphResponseSchema>;
