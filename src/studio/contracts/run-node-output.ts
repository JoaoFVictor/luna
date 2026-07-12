import { z } from "zod";
import { boundedStudioJsonValueSchema } from "./bounded-json.js";
import { StudioDigestSchema } from "./digests.js";
import { RunGraphRunSummarySchema } from "./run-graph.js";

export const STUDIO_RUN_NODE_OUTPUT_LIMITS = Object.freeze({
  maxBytes: 256 * 1024,
  maxDepth: 24,
  maxEntries: 4_096,
  maxKeyLength: 256
} as const);
export const MAX_RUN_OUTPUT_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_RUN_NODE_OUTPUT_COMPARISON_CHANGES = 512;

const NodeIdSchema = z.string().trim().min(1).max(256);

export const AvailableRunNodeOutputSnapshotSchema = z.object({
  availability: z.literal("available"),
  value: boundedStudioJsonValueSchema(STUDIO_RUN_NODE_OUTPUT_LIMITS),
  redaction: z.object({
    mode: z.literal("best_effort"),
    changed: z.boolean()
  }).strict()
}).strict();

export const UnavailableRunNodeOutputSnapshotSchema = z.object({
  availability: z.literal("unavailable"),
  reason: z.enum(["value_limit_exceeded", "snapshot_budget_exhausted"])
}).strict();

export const RunNodeOutputSnapshotSchema = z.discriminatedUnion(
  "availability",
  [AvailableRunNodeOutputSnapshotSchema, UnavailableRunNodeOutputSnapshotSchema]
);
export type RunNodeOutputSnapshot = z.infer<
  typeof RunNodeOutputSnapshotSchema
>;

const AvailableRunNodeOutputResponseSchema = z.object({
  schema_version: z.literal(1),
  availability: z.literal("available"),
  run: RunGraphRunSummarySchema,
  node_id: NodeIdSchema,
  graph_hash: StudioDigestSchema,
  outcome_hash: StudioDigestSchema,
  output: RunNodeOutputSnapshotSchema
}).strict();

const UnavailableRunNodeOutputResponseSchema = z.object({
  schema_version: z.literal(1),
  availability: z.literal("unavailable"),
  run: RunGraphRunSummarySchema,
  node_id: NodeIdSchema,
  reason: z.enum([
    "graph_unavailable",
    "run_not_terminal",
    "outcome_unavailable",
    "output_not_recorded"
  ])
}).strict();

export const RunNodeOutputResponseSchema = z.discriminatedUnion(
  "availability",
  [AvailableRunNodeOutputResponseSchema, UnavailableRunNodeOutputResponseSchema]
);
export type RunNodeOutputResponse = z.infer<
  typeof RunNodeOutputResponseSchema
>;

const RunNodeOutputComparisonPathSchema = z.array(z.string().max(256))
  .max(STUDIO_RUN_NODE_OUTPUT_LIMITS.maxDepth);

const RunNodeOutputComparisonChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("added"),
    path: RunNodeOutputComparisonPathSchema,
    after: boundedStudioJsonValueSchema(STUDIO_RUN_NODE_OUTPUT_LIMITS)
  }).strict(),
  z.object({
    kind: z.literal("removed"),
    path: RunNodeOutputComparisonPathSchema,
    before: boundedStudioJsonValueSchema(STUDIO_RUN_NODE_OUTPUT_LIMITS)
  }).strict(),
  z.object({
    kind: z.literal("changed"),
    path: RunNodeOutputComparisonPathSchema,
    before: boundedStudioJsonValueSchema(STUDIO_RUN_NODE_OUTPUT_LIMITS),
    after: boundedStudioJsonValueSchema(STUDIO_RUN_NODE_OUTPUT_LIMITS)
  }).strict()
]);

const RunNodeOutputComparisonRefSchema = z.object({
  run: RunGraphRunSummarySchema,
  graph_hash: StudioDigestSchema,
  outcome_hash: StudioDigestSchema,
  redaction_changed: z.boolean()
}).strict();

const RunNodeOutputUnavailableReasonSchema = z.enum([
  "graph_unavailable",
  "run_not_terminal",
  "outcome_unavailable",
  "output_not_recorded",
  "value_limit_exceeded",
  "snapshot_budget_exhausted"
]);

const ComparableRunNodeOutputResponseSchema = z.object({
  schema_version: z.literal(1),
  availability: z.literal("comparable"),
  workflow_id: RunGraphRunSummarySchema.shape.workflow_id,
  node_id: NodeIdSchema,
  baseline: RunNodeOutputComparisonRefSchema,
  current: RunNodeOutputComparisonRefSchema,
  same_workflow_revision: z.boolean(),
  summary: z.object({
    added: z.number().int().safe().nonnegative(),
    removed: z.number().int().safe().nonnegative(),
    changed: z.number().int().safe().nonnegative(),
    total: z.number().int().safe().nonnegative()
  }).strict(),
  changes: z.array(RunNodeOutputComparisonChangeSchema)
    .max(MAX_RUN_NODE_OUTPUT_COMPARISON_CHANGES),
  truncated: z.boolean(),
  redaction: z.literal("best_effort")
}).strict().superRefine((comparison, context) => {
  if (
    comparison.baseline.run.workflow_id !== comparison.workflow_id ||
    comparison.current.run.workflow_id !== comparison.workflow_id
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["workflow_id"],
      message: "Comparable outputs must belong to the declared workflow"
    });
  }
  const expectedTotal = comparison.summary.added +
    comparison.summary.removed + comparison.summary.changed;
  if (comparison.summary.total !== expectedTotal) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["summary", "total"],
      message: "Comparison total must equal its categorized counts"
    });
  }
  if (comparison.truncated !== (comparison.summary.total > comparison.changes.length)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["truncated"],
      message: "Comparison truncation must match omitted change details"
    });
  }
  const detailed = { added: 0, removed: 0, changed: 0 };
  const paths = new Set<string>();
  for (const [index, change] of comparison.changes.entries()) {
    detailed[change.kind] += 1;
    const path = JSON.stringify(change.path);
    if (paths.has(path)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changes", index, "path"],
        message: "Comparison change paths must be unique"
      });
    }
    paths.add(path);
  }
  for (const kind of ["added", "removed", "changed"] as const) {
    const exact = !comparison.truncated;
    if (
      (exact && detailed[kind] !== comparison.summary[kind]) ||
      (!exact && detailed[kind] > comparison.summary[kind])
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", kind],
        message: "Comparison summary does not match its detailed changes"
      });
    }
  }
});

const UnavailableRunNodeOutputComparisonResponseSchema = z.object({
  schema_version: z.literal(1),
  availability: z.literal("unavailable"),
  node_id: NodeIdSchema,
  baseline_run: RunGraphRunSummarySchema,
  current_run: RunGraphRunSummarySchema,
  reason: z.enum(["workflow_mismatch", "output_unavailable"]),
  unavailable_sides: z.array(z.object({
    side: z.enum(["baseline", "current"]),
    reason: RunNodeOutputUnavailableReasonSchema
  }).strict()).max(2)
}).strict().superRefine((comparison, context) => {
  const sameWorkflow = comparison.baseline_run.workflow_id ===
    comparison.current_run.workflow_id;
  if (comparison.reason === "workflow_mismatch") {
    if (sameWorkflow || comparison.unavailable_sides.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "Workflow mismatch must describe two different workflows only"
      });
    }
    return;
  }
  if (!sameWorkflow || comparison.unavailable_sides.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["unavailable_sides"],
      message: "Unavailable output comparison requires at least one retained-output reason"
    });
  }
  if (new Set(comparison.unavailable_sides.map((side) => side.side)).size !==
    comparison.unavailable_sides.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["unavailable_sides"],
      message: "Unavailable comparison sides must be unique"
    });
  }
});

export const RunNodeOutputComparisonResponseSchema = z.union([
  ComparableRunNodeOutputResponseSchema,
  UnavailableRunNodeOutputComparisonResponseSchema
]);
export type RunNodeOutputComparisonResponse = z.infer<
  typeof RunNodeOutputComparisonResponseSchema
>;
