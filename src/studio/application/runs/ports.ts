import { z } from "zod";
import { WorkflowIdSchema } from "../../../core/router/invocation.js";
import {
  RunDisplayStatusSchema,
  RunEventSchema,
  RunFailureSchema,
  RunGraphSnapshotHandleSchema,
  RunOpaqueIdSchema,
  RunRecordSchema,
  RunRuntimeStatusSchema,
  RunSubjectSchema,
  type RunCatalogPage,
  type RunCatalogItem,
  type RunEventPage,
  type RunRecord
} from "../../contracts/runs.js";
import { StudioDigestSchema } from "../../contracts/digests.js";
import { StudioJsonValueSchema } from "../../contracts/json.js";
import { StudioRunPlanIdSchema } from "../../contracts/run-launch-primitives.js";
import { StudioRunInputProvenanceSchema } from "../../contracts/run-provenance.js";
import { StudioRunDefinitionSourceSchema } from "../../contracts/run-definition-source.js";
import { RunGraphOutcomeProofSchema } from "./graph-snapshot.js";
import { StudioRunExecutionProfileSummarySchema } from "../../contracts/manual-test-data.js";

const TimestampSchema = z.string().datetime({ offset: true });
const PageLimitSchema = z.number().int().safe().min(1).max(200);

const InitialDefinitionMetadataSchema = z
  .object({
    workflow_revision: StudioDigestSchema,
    definition_bundle_hash: StudioDigestSchema,
    catalog_fingerprint: StudioDigestSchema,
    execution_snapshot_hash: StudioDigestSchema
  })
  .strict();

export const PreallocateRunInputSchema = z
  .object({
    transition_id: RunOpaqueIdSchema,
    event_id: RunOpaqueIdSchema,
    run_id: RunOpaqueIdSchema,
    accepted_plan_id: StudioRunPlanIdSchema.optional(),
    input_provenance: StudioRunInputProvenanceSchema.optional(),
    execution_profile: StudioRunExecutionProfileSummarySchema.optional(),
    execution_profile_hash: StudioDigestSchema.optional(),
    correlation_id: RunOpaqueIdSchema.optional(),
    job_id: RunOpaqueIdSchema.optional(),
    workflow_id: WorkflowIdSchema,
    definition_source: StudioRunDefinitionSourceSchema.optional(),
    definition: InitialDefinitionMetadataSchema,
    created_at: TimestampSchema,
    source: z.string().trim().min(1).max(256).optional(),
    subject: RunSubjectSchema.optional(),
    repository_id: z.string().trim().min(1).max(256).optional(),
    graph_snapshot_handle: RunGraphSnapshotHandleSchema.optional(),
    side_effects: z.array(StudioJsonValueSchema).max(10_000).default([])
  })
  .strict()
  .superRefine((input, context) => {
    if (
      (input.accepted_plan_id === undefined) !==
      (input.input_provenance === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["input_provenance"],
        message: "Accepted plan and input provenance must appear together"
      });
    }
    if (
      (input.execution_profile === undefined) !==
      (input.execution_profile_hash === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["execution_profile_hash"],
        message: "Execution profile and hash must appear together"
      });
    }
  });
export type PreallocateRunInput = z.input<typeof PreallocateRunInputSchema>;

const DispatchPreparingTransitionSchema = z
  .object({
    kind: z.literal("dispatch_preparing"),
    owner_id: RunOpaqueIdSchema
  })
  .strict();

const DispatchStartedTransitionSchema = z
  .object({
    kind: z.literal("dispatch_started"),
    owner_id: RunOpaqueIdSchema,
    active_node_ids: z.array(z.string().trim().min(1).max(256)).max(10_000).default([])
  })
  .strict();

const DispatchRecoveryClaimTransitionSchema = z
  .object({
    kind: z.literal("dispatch_recovery_claim"),
    previous_owner_id: RunOpaqueIdSchema,
    owner_id: RunOpaqueIdSchema
  })
  .strict();

const DispatchRejectedTransitionSchema = z
  .object({
    kind: z.literal("dispatch_rejected"),
    owner_id: RunOpaqueIdSchema.optional(),
    failure: RunFailureSchema
  })
  .strict();

const HeartbeatTransitionSchema = z
  .object({
    kind: z.literal("heartbeat"),
    owner_id: RunOpaqueIdSchema
  })
  .strict();

const ProgressTransitionSchema = z
  .object({
    kind: z.literal("progress"),
    owner_id: RunOpaqueIdSchema,
    active_node_ids: z.array(z.string().trim().min(1).max(256)).max(10_000),
    artifact_count: z.number().int().safe().nonnegative().optional(),
    interrupt_count: z.number().int().safe().nonnegative().optional()
  })
  .strict();

const NodeLifecycleEventIdentitySchema = z
  .object({
    type: z.enum(["node.started", "node.succeeded", "node.failed"]),
    node_id: z.string().trim().min(1).max(256),
    attempt: z.number().int().safe().positive()
  })
  .strict();

export const NodeLifecycleObservedEventSchema =
  NodeLifecycleEventIdentitySchema.extend({
    observed_at: TimestampSchema,
    artifact_count: z.number().int().safe().nonnegative(),
    interrupt_count: z.number().int().safe().nonnegative()
  }).strict();

const NodeLifecycleTransitionSchema = z
  .object({
    kind: z.literal("node_lifecycle"),
    owner_id: RunOpaqueIdSchema,
    event: NodeLifecycleObservedEventSchema
  })
  .strict();

const LifecycleProjectionDegradedTransitionSchema = z
  .object({
    kind: z.literal("lifecycle_projection_degraded"),
    owner_id: RunOpaqueIdSchema,
    failed_event: NodeLifecycleEventIdentitySchema.extend({
      observed_at: TimestampSchema
    }).strict()
  })
  .strict();

const RuntimeStatusTransitionSchema = z
  .object({
    kind: z.literal("runtime_status"),
    owner_id: RunOpaqueIdSchema,
    status: RunRuntimeStatusSchema,
    active_node_ids: z.array(z.string().trim().min(1).max(256)).max(10_000).default([]),
    failed_node_id: z.string().trim().min(1).max(256).optional(),
    failure: RunFailureSchema.optional(),
    artifact_count: z.number().int().safe().nonnegative().optional(),
    interrupt_count: z.number().int().safe().nonnegative().optional(),
    completeness: z.enum(["complete", "partial"]).optional(),
    outcome_proof: RunGraphOutcomeProofSchema.optional()
  })
  .strict();

export const RunTransitionSchema = z.discriminatedUnion("kind", [
  DispatchPreparingTransitionSchema,
  DispatchStartedTransitionSchema,
  DispatchRecoveryClaimTransitionSchema,
  DispatchRejectedTransitionSchema,
  HeartbeatTransitionSchema,
  ProgressTransitionSchema,
  NodeLifecycleTransitionSchema,
  LifecycleProjectionDegradedTransitionSchema,
  RuntimeStatusTransitionSchema
]);
export type RunTransition = z.infer<typeof RunTransitionSchema>;

export const AppendRunTransitionInputSchema = z
  .object({
    run_id: RunOpaqueIdSchema,
    transition_id: RunOpaqueIdSchema,
    event_id: RunOpaqueIdSchema,
    expected_revision: z.number().int().safe().positive(),
    occurred_at: TimestampSchema,
    transition: RunTransitionSchema
  })
  .strict();
export type AppendRunTransitionInput = z.input<
  typeof AppendRunTransitionInputSchema
>;

export const AppendRunEventInputSchema = z
  .object({
    run_id: RunOpaqueIdSchema,
    event_id: RunOpaqueIdSchema,
    expected_last_sequence: z.number().int().safe().nonnegative(),
    event_type: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z][A-Za-z0-9._-]*$/)
      .refine((value) => !value.startsWith("run."), {
        message: "The run.* event namespace is reserved for ledger transitions"
      }),
    occurred_at: TimestampSchema,
    data: StudioJsonValueSchema
  })
  .strict();
export type AppendRunEventInput = z.infer<typeof AppendRunEventInputSchema>;

export const RunEventListQuerySchema = z
  .object({
    run_id: RunOpaqueIdSchema,
    direction: z.enum(["asc", "desc"]).default("asc"),
    event_types: z
      .array(z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9._-]*$/))
      .max(64)
      .default([]),
    limit: PageLimitSchema.default(50),
    after_sequence: z.number().int().safe().nonnegative().optional(),
    cursor: z.string().min(1).max(4_096).optional()
  })
  .strict()
  .superRefine((query, context) => {
    if (new Set(query.event_types).size !== query.event_types.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["event_types"],
        message: "Event type filters must be unique"
      });
    }
    if (query.cursor !== undefined && query.after_sequence !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["after_sequence"],
        message: "Event cursor and after_sequence are mutually exclusive"
      });
    }
    if (query.after_sequence !== undefined && query.direction !== "asc") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["direction"],
        message: "after_sequence requires ascending event order"
      });
    }
  });
export type RunEventListQuery = z.input<typeof RunEventListQuerySchema>;

export const RunCatalogFiltersSchema = z
  .object({
    workflow_id: WorkflowIdSchema.optional(),
    statuses: z.array(RunDisplayStatusSchema).max(16).default([]),
    source: z.string().trim().min(1).max(256).optional(),
    created_from: TimestampSchema.optional(),
    created_to: TimestampSchema.optional(),
    correlation_id: RunOpaqueIdSchema.optional(),
    job_id: RunOpaqueIdSchema.optional(),
    accepted_plan_id: StudioRunPlanIdSchema.optional()
  })
  .strict()
  .superRefine((filters, context) => {
    if (new Set(filters.statuses).size !== filters.statuses.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["statuses"],
        message: "Status filters must be unique"
      });
    }
    if (filters.created_from !== undefined && filters.created_to !== undefined &&
      Date.parse(filters.created_from) > Date.parse(filters.created_to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["created_to"],
        message: "End time cannot precede start time"
      });
    }
  });
export type RunCatalogFilters = z.input<typeof RunCatalogFiltersSchema>;

export const RunCatalogListQuerySchema = z
  .object({
    filters: RunCatalogFiltersSchema.default({}),
    direction: z.enum(["asc", "desc"]).default("desc"),
    limit: PageLimitSchema.default(50),
    cursor: z.string().min(1).max(4_096).optional()
  })
  .strict();
export type RunCatalogListQuery = z.input<typeof RunCatalogListQuerySchema>;

export const RunMutationResultSchema = z
  .object({
    record: RunRecordSchema,
    applied: z.boolean(),
    transition_revision: z.number().int().safe().positive(),
    catalog_projection_pending: z.boolean()
  })
  .strict();
export type RunMutationResult = z.infer<typeof RunMutationResultSchema>;

export const RunEventAppendResultSchema = z
  .object({
    event: RunEventSchema,
    applied: z.boolean()
  })
  .strict();
export type RunEventAppendResult = z.infer<typeof RunEventAppendResultSchema>;

export type RunOrphanCandidate = {
  readonly record: RunRecord;
  readonly stale_since: string;
};

export type RunOrphanCursor = {
  readonly stale_since: string;
  readonly run_id: string;
};

export interface RunLedgerPort {
  preallocate(input: PreallocateRunInput): Promise<RunMutationResult>;
  appendTransition(input: AppendRunTransitionInput): Promise<RunMutationResult>;
  get(runId: string): Promise<RunRecord | undefined>;
  listOrphanCandidates(input: {
    stale_before: string;
    limit?: number;
    cursor?: RunOrphanCursor;
  }): Promise<readonly RunOrphanCandidate[]>;
}

export interface RunEventLedgerPort {
  append(input: AppendRunEventInput): Promise<RunEventAppendResult>;
  list(query: RunEventListQuery): Promise<RunEventPage>;
}

export interface RunCatalogPort {
  get(runId: string): Promise<RunCatalogItem | undefined>;
  list(query?: RunCatalogListQuery): Promise<RunCatalogPage>;
}

export interface RunCatalogProjectorPort {
  projectPending(options?: { limit?: number }): Promise<number>;
  rebuild(): Promise<number>;
}

export const HistoricalRunImportSchema = z
  .object({
    record: RunRecordSchema.refine(
      (record) =>
        record.dispatch_status === "historical_unknown" &&
        record.lifecycle_projection === "unknown" &&
        record.completeness !== "complete",
      "Historical imports require an unknown immutable lifecycle"
    ),
    transition_id: RunOpaqueIdSchema,
    event_id: RunOpaqueIdSchema
  })
  .strict();
export type HistoricalRunImport = z.infer<typeof HistoricalRunImportSchema>;

export interface RunReconcilerPort {
  importHistorical(input: HistoricalRunImport): Promise<RunMutationResult>;
}
