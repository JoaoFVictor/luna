import { z } from "zod";
import { WorkflowIdSchema } from "../../core/router/invocation.js";
import { StudioDigestSchema } from "./digests.js";
import { StudioJsonValueSchema } from "./json.js";
import { StudioRunPlanIdSchema } from "./run-launch-primitives.js";
import { StudioRunOpaqueIdSchema } from "./run-launch-primitives.js";
import { StudioRunInputProvenanceSchema } from "./run-provenance.js";
import { StudioRunDefinitionSourceSchema } from "./run-definition-source.js";
import { remoteUrlContainsCredentials } from "../../core/security/url-credentials.js";
import { StudioRunExecutionProfileSummarySchema } from "./manual-test-data.js";

const BoundedStringSchema = z.string().trim().min(1).max(256);
const TimestampSchema = z.string().datetime({ offset: true });
const SafeCountSchema = z.number().int().safe().nonnegative();

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export const RunOpaqueIdSchema = StudioRunOpaqueIdSchema;

export const RunGraphSnapshotHandleSchema = z
  .string()
  .min(25)
  .max(259)
  .regex(/^gs_[A-Za-z0-9_-]{22,256}$/, "Invalid graph snapshot handle");

export const RunDispatchStatusSchema = z.enum([
  "queued",
  "preparing",
  "started",
  "rejected",
  "historical_unknown"
]);
export type RunDispatchStatus = z.infer<typeof RunDispatchStatusSchema>;

export const RunRuntimeStatusSchema = z.enum([
  "running",
  "waiting_for_input",
  "waiting_for_retry",
  "resuming",
  "succeeded",
  "failed",
  "outcome_unknown",
  "timed_out",
  "cancelled"
]);
export type RunRuntimeStatus = z.infer<typeof RunRuntimeStatusSchema>;

export const RunTerminalStatusSchema = z.enum([
  "succeeded",
  "failed",
  "outcome_unknown",
  "timed_out",
  "cancelled"
]);
export type RunTerminalStatus = z.infer<typeof RunTerminalStatusSchema>;

export const RunDisplayStatusSchema = z.union([
  RunDispatchStatusSchema,
  RunRuntimeStatusSchema
]);
export type RunDisplayStatus = z.infer<typeof RunDisplayStatusSchema>;

export const RunCompletenessSchema = z.enum(["complete", "partial", "legacy"]);
export type RunCompleteness = z.infer<typeof RunCompletenessSchema>;

export const RunLifecycleProjectionSchema = z.enum([
  "exact",
  "degraded",
  "unknown"
]);
export type RunLifecycleProjection = z.infer<
  typeof RunLifecycleProjectionSchema
>;

export const RunSubjectSchema = z
  .object({
    id: BoundedStringSchema.optional(),
    title: z.string().trim().min(1).max(2_000).optional(),
    url: z
      .string()
      .url()
      .max(8_192)
      .refine(isHttpUrl, "Subject URL must use HTTP or HTTPS")
      .refine(
        (value) => !remoteUrlContainsCredentials(value),
        "Subject URL must not contain credentials"
      )
      .optional()
  })
  .strict()
  .refine((subject) => Object.keys(subject).length > 0, {
    message: "Subject must contain at least one field"
  });
export type RunSubject = z.infer<typeof RunSubjectSchema>;

export const RunFailureCategorySchema = z.enum([
  "configuration",
  "validation",
  "authentication",
  "authorization",
  "dependency",
  "transport",
  "rate_limit",
  "timeout",
  "runtime",
  "external",
  "unknown"
]);
export type RunFailureCategory = z.infer<typeof RunFailureCategorySchema>;

export const RunFailureRetryabilitySchema = z.enum([
  "safe",
  "unsafe",
  "conditional",
  "unknown"
]);
export type RunFailureRetryability = z.infer<
  typeof RunFailureRetryabilitySchema
>;

export const RunFailureCauseSchema = z
  .object({
    code: BoundedStringSchema.optional(),
    message: z.string().trim().min(1).max(1_024).optional()
  })
  .strict()
  .refine((cause) => Object.keys(cause).length > 0, {
    message: "Failure cause must contain at least one field"
  });
export type RunFailureCause = z.infer<typeof RunFailureCauseSchema>;

export const RunFailureDiagnosticsSchema = z
  .object({
    category: RunFailureCategorySchema.optional(),
    retryability: RunFailureRetryabilitySchema.optional(),
    operation_id: BoundedStringSchema.optional(),
    status_code: z.number().int().min(100).max(599).optional(),
    cause: RunFailureCauseSchema.optional(),
    certainty: z.enum(["known", "unknown"]).optional()
  })
  .strict()
  .refine((diagnostics) => Object.keys(diagnostics).length > 0, {
    message: "Failure diagnostics must contain at least one field"
  });
export type RunFailureDiagnostics = z.infer<
  typeof RunFailureDiagnosticsSchema
>;

export const RunFailureSchema = z
  .object({
    code: RunOpaqueIdSchema,
    message: z.string().trim().min(1).max(4_096),
    diagnostics: RunFailureDiagnosticsSchema.optional()
  })
  .strict();
export type RunFailure = z.infer<typeof RunFailureSchema>;

const OptionalDefinitionMetadataShape = {
  workflow_revision: StudioDigestSchema.optional(),
  definition_bundle_hash: StudioDigestSchema.optional(),
  catalog_fingerprint: StudioDigestSchema.optional(),
  execution_snapshot_hash: StudioDigestSchema.optional()
} as const;

export const RunRecordSchema = z
  .object({
    schema_version: z.literal(1),
    record_revision: z.number().int().safe().positive(),
    run_id: RunOpaqueIdSchema,
    accepted_plan_id: StudioRunPlanIdSchema.optional(),
    input_provenance: StudioRunInputProvenanceSchema.optional(),
    execution_profile: StudioRunExecutionProfileSummarySchema.optional(),
    execution_profile_hash: StudioDigestSchema.optional(),
    correlation_id: RunOpaqueIdSchema.optional(),
    job_id: RunOpaqueIdSchema.optional(),
    workflow_id: WorkflowIdSchema,
    definition_source: StudioRunDefinitionSourceSchema.optional(),
    ...OptionalDefinitionMetadataShape,
    dispatch_status: RunDispatchStatusSchema,
    run_status: RunRuntimeStatusSchema.optional(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    started_at: TimestampSchema.optional(),
    finished_at: TimestampSchema.optional(),
    owner_id: RunOpaqueIdSchema.optional(),
    owner_claimed_at: TimestampSchema.optional(),
    heartbeat_at: TimestampSchema.optional(),
    source: BoundedStringSchema.optional(),
    subject: RunSubjectSchema.optional(),
    repository_id: BoundedStringSchema.optional(),
    active_node_ids: z.array(BoundedStringSchema).max(10_000),
    failed_node_id: BoundedStringSchema.optional(),
    failure: RunFailureSchema.optional(),
    graph_snapshot_handle: RunGraphSnapshotHandleSchema.optional(),
    artifact_count: SafeCountSchema.optional(),
    interrupt_count: SafeCountSchema.optional(),
    side_effects: z.array(StudioJsonValueSchema).max(10_000),
    lifecycle_projection: RunLifecycleProjectionSchema.default("exact"),
    completeness: RunCompletenessSchema
  })
  .strict()
  .superRefine((record, context) => {
    const uniqueNodes = new Set(record.active_node_ids);
    if (uniqueNodes.size !== record.active_node_ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["active_node_ids"],
        message: "Active node ids must be unique"
      });
    }

    if (
      (record.accepted_plan_id === undefined) !==
      (record.input_provenance === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["input_provenance"],
        message: "Accepted plan and input provenance must appear together"
      });
    }
    if (
      (record.execution_profile === undefined) !==
      (record.execution_profile_hash === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["execution_profile_hash"],
        message: "Execution profile and hash must appear together"
      });
    }

    if (record.completeness === "complete") {
      for (const field of [
        "workflow_revision",
        "definition_bundle_hash",
        "catalog_fingerprint",
        "execution_snapshot_hash"
      ] as const) {
        if (record[field] === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: "Complete runs require definition metadata"
          });
        }
      }
    }

    validateRunStateShape(record, context);
    validateRunTimestamps(record, context);
  });
export type RunRecord = z.infer<typeof RunRecordSchema>;

type RefineContext = z.RefinementCtx;
type RunStateShape = z.infer<typeof RunRecordSchema>;

function issue(context: RefineContext, path: string, message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
}

function validateRunStateShape(record: RunStateShape, context: RefineContext): void {
  const terminal = record.run_status !== undefined &&
    RunTerminalStatusSchema.safeParse(record.run_status).success;
  const beforeStart = record.dispatch_status === "queued" ||
    record.dispatch_status === "preparing";
  const historical = record.dispatch_status === "historical_unknown";

  if (historical) {
    validateHistoricalRunStateShape(record, context);
  } else {
    if (record.lifecycle_projection === "unknown") {
      issue(
        context,
        "lifecycle_projection",
        "Only historical runs may have unknown lifecycle projection"
      );
    }
    if (record.artifact_count === undefined) {
      issue(context, "artifact_count", "Canonical runs require artifact count");
    }
    if (record.interrupt_count === undefined) {
      issue(context, "interrupt_count", "Canonical runs require interrupt count");
    }
  }

  if (beforeStart && record.run_status !== undefined) {
    issue(context, "run_status", "Run status is unavailable before dispatch starts");
  }
  if (beforeStart && (record.started_at !== undefined || record.finished_at !== undefined)) {
    issue(context, "started_at", "Pre-start runs cannot have lifecycle timestamps");
  }
  if (record.dispatch_status === "queued" && record.owner_id !== undefined) {
    issue(context, "owner_id", "Queued runs cannot have an owner");
  }
  if (record.dispatch_status === "preparing" &&
    (record.owner_id === undefined || record.heartbeat_at === undefined)) {
    issue(context, "owner_id", "Preparing dispatches require owner and heartbeat");
  }
  if (record.dispatch_status === "rejected") {
    if (record.run_status !== undefined || record.started_at !== undefined) {
      issue(context, "run_status", "Rejected dispatches never enter runtime lifecycle");
    }
    if (record.finished_at === undefined || record.failure === undefined) {
      issue(context, "finished_at", "Rejected dispatches require finish time and failure");
    }
  }
  if (record.dispatch_status === "started") {
    if (record.run_status === undefined || record.started_at === undefined) {
      issue(context, "run_status", "Started dispatches require runtime status and start time");
    }
    if (record.owner_id === undefined || record.heartbeat_at === undefined) {
      issue(context, "owner_id", "Started dispatches require owner and heartbeat");
    }
  }
  if ((record.owner_id === undefined) !== (record.owner_claimed_at === undefined)) {
    issue(context, "owner_claimed_at", "Owner and claim time must appear together");
  }
  if ((record.heartbeat_at === undefined) !== (record.owner_id === undefined)) {
    issue(context, "heartbeat_at", "Owner and heartbeat must appear together");
  }
  if (terminal !== (record.finished_at !== undefined && record.dispatch_status === "started")) {
    issue(context, "finished_at", "Runtime terminal status and finish time must agree");
  }
  if ((record.run_status === "failed" ||
    record.run_status === "outcome_unknown" ||
    record.run_status === "timed_out") &&
    record.failure === undefined) {
    issue(context, "failure", "Failed, uncertain, and timed-out runs require details");
  }
  if (record.failed_node_id !== undefined && record.failure === undefined) {
    issue(context, "failed_node_id", "Failed node requires a failure");
  }
  const failureState = record.dispatch_status === "rejected" ||
    record.run_status === "failed" ||
    record.run_status === "outcome_unknown" ||
    record.run_status === "timed_out" ||
    record.run_status === "cancelled";
  if (!failureState &&
    (record.failure !== undefined || record.failed_node_id !== undefined)) {
    issue(context, "failure", "Failure details require a failed terminal state");
  }
  if (terminal && record.active_node_ids.length > 0) {
    issue(context, "active_node_ids", "Terminal runs cannot have active nodes");
  }
  if (
    terminal &&
    record.lifecycle_projection === "degraded" &&
    record.completeness === "complete"
  ) {
    issue(
      context,
      "completeness",
      "A terminal run with degraded lifecycle projection must be partial"
    );
  }
}

function validateHistoricalRunStateShape(
  record: RunStateShape,
  context: RefineContext
): void {
  if (record.completeness === "complete") {
    issue(context, "completeness", "Historical runs cannot claim complete metadata");
  }
  if (record.lifecycle_projection !== "unknown") {
    issue(
      context,
      "lifecycle_projection",
      "Historical runs require unknown lifecycle projection"
    );
  }
  for (const field of [
    "run_status",
    "started_at",
    "finished_at",
    "owner_id",
    "owner_claimed_at",
    "heartbeat_at",
    "failed_node_id",
    "failure",
    "artifact_count",
    "interrupt_count"
  ] as const) {
    if (record[field] !== undefined) {
      issue(
        context,
        field,
        "Historical run lifecycle data must remain unavailable"
      );
    }
  }
  if (record.active_node_ids.length > 0) {
    issue(
      context,
      "active_node_ids",
      "Historical runs cannot claim active runtime nodes"
    );
  }
}

function validateRunTimestamps(record: RunStateShape, context: RefineContext): void {
  const created = Date.parse(record.created_at);
  const updated = Date.parse(record.updated_at);
  if (updated < created) {
    issue(context, "updated_at", "Updated time cannot precede creation");
  }
  if (record.owner_claimed_at !== undefined && Date.parse(record.owner_claimed_at) < created) {
    issue(context, "owner_claimed_at", "Owner claim cannot precede creation");
  }
  if (record.started_at !== undefined && Date.parse(record.started_at) < created) {
    issue(context, "started_at", "Start time cannot precede creation");
  }
  if (record.started_at !== undefined && record.owner_claimed_at !== undefined &&
    Date.parse(record.started_at) < Date.parse(record.owner_claimed_at)) {
    issue(context, "started_at", "Start time cannot precede owner claim");
  }
  if (record.heartbeat_at !== undefined) {
    const heartbeat = Date.parse(record.heartbeat_at);
    if (heartbeat < created || (record.owner_claimed_at !== undefined &&
      heartbeat < Date.parse(record.owner_claimed_at))) {
      issue(context, "heartbeat_at", "Heartbeat cannot precede owner claim");
    }
  }
  if (record.finished_at !== undefined) {
    const origin = record.started_at === undefined ? created : Date.parse(record.started_at);
    if (Date.parse(record.finished_at) < origin) {
      issue(context, "finished_at", "Finish time cannot precede run start");
    }
    if (record.heartbeat_at !== undefined &&
      Date.parse(record.finished_at) < Date.parse(record.heartbeat_at)) {
      issue(context, "finished_at", "Finish time cannot precede heartbeat");
    }
  }
  for (const [field, timestamp] of [
    ["owner_claimed_at", record.owner_claimed_at],
    ["started_at", record.started_at],
    ["heartbeat_at", record.heartbeat_at],
    ["finished_at", record.finished_at]
  ] as const) {
    if (timestamp !== undefined && Date.parse(timestamp) > updated) {
      issue(context, field, "Lifecycle timestamp cannot follow update time");
    }
  }
}

export const RunEventSchema = z
  .object({
    schema_version: z.literal(1),
    run_id: RunOpaqueIdSchema,
    sequence: z.number().int().safe().positive(),
    event_id: RunOpaqueIdSchema,
    event_type: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z][A-Za-z0-9._-]*$/),
    occurred_at: TimestampSchema,
    record_revision: z.number().int().safe().positive().optional(),
    data: StudioJsonValueSchema
  })
  .strict();
export type RunEvent = z.infer<typeof RunEventSchema>;

export const RunCatalogItemSchema = z
  .object({
    record: RunRecordSchema,
    status: RunDisplayStatusSchema,
    wall_duration_ms: SafeCountSchema.optional()
  })
  .strict()
  .superRefine((item, context) => {
    if (item.status !== (item.record.run_status ?? item.record.dispatch_status)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Catalog status must match the run lifecycle"
      });
    }
    if (
      (item.record.dispatch_status === "historical_unknown") !==
      (item.wall_duration_ms === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["wall_duration_ms"],
        message: "Wall duration is unavailable only for historical runs"
      });
    }
  });
export type RunCatalogItem = z.infer<typeof RunCatalogItemSchema>;

export const RunCatalogSummarySchema = z
  .object({
    run_id: RunOpaqueIdSchema,
    accepted_plan_id: StudioRunPlanIdSchema.optional(),
    input_provenance: StudioRunInputProvenanceSchema.optional(),
    correlation_id: RunOpaqueIdSchema.optional(),
    job_id: RunOpaqueIdSchema.optional(),
    workflow_id: WorkflowIdSchema,
    workflow_revision: StudioDigestSchema.optional(),
    execution_snapshot_hash: StudioDigestSchema.optional(),
    dispatch_status: RunDispatchStatusSchema,
    run_status: RunRuntimeStatusSchema.optional(),
    status: RunDisplayStatusSchema,
    created_at: TimestampSchema,
    started_at: TimestampSchema.optional(),
    finished_at: TimestampSchema.optional(),
    source: BoundedStringSchema.optional(),
    subject: RunSubjectSchema.optional(),
    repository_id: BoundedStringSchema.optional(),
    failed_node_id: BoundedStringSchema.optional(),
    artifact_count: SafeCountSchema.optional(),
    interrupt_count: SafeCountSchema.optional(),
    completeness: RunCompletenessSchema,
    wall_duration_ms: SafeCountSchema.optional()
  })
  .strict()
  .superRefine((summary, context) => {
    if (summary.status !== (summary.run_status ?? summary.dispatch_status)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Catalog status must match the run lifecycle"
      });
    }
    const historical = summary.dispatch_status === "historical_unknown";
    for (const field of [
      "artifact_count",
      "interrupt_count",
      "wall_duration_ms"
    ] as const) {
      if (historical !== (summary[field] === undefined)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is unavailable only for historical runs`
        });
      }
    }
  });
export type RunCatalogSummary = z.infer<typeof RunCatalogSummarySchema>;

export const RunEventPageSchema = z
  .object({
    items: z.array(RunEventSchema),
    next_cursor: z.string().min(1).nullable(),
    as_of_sequence: SafeCountSchema
  })
  .strict();
export type RunEventPage = z.infer<typeof RunEventPageSchema>;

export const RunCatalogPageSchema = z
  .object({
    items: z.array(RunCatalogSummarySchema),
    next_cursor: z.string().min(1).nullable(),
    as_of: TimestampSchema
  })
  .strict();
export type RunCatalogPage = z.infer<typeof RunCatalogPageSchema>;
