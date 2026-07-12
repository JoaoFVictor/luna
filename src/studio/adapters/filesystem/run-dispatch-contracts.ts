import { z } from "zod";
import { RouteTargetSchema } from "../../../core/router/invocation.js";
import { workflowExecutionScopesEqual } from "../../../core/workflow/execution-scope.js";
import { PreallocateRunInputSchema } from "../../application/runs/ports.js";
import {
  StudioRunExecutionSnapshotSchema,
  StudioRunPlanIdSchema,
  StudioRunPlanRequestSchema
} from "../../contracts/run-launch.js";
import { StudioRunTimestampSchema } from "../../contracts/run-launch-primitives.js";
import { StudioDigestSchema } from "../../contracts/digests.js";
import { RunOpaqueIdSchema } from "../../contracts/runs.js";
import { NativeStudioRunSnapshotManifestSchema } from "../native/run-snapshot-contracts.js";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import { STUDIO_STANDARD_EXECUTION_PROFILE_HASH } from "../../contracts/manual-test-data.js";

const NativeStudioQueuedRunHandleSchema = z
  .object({
    run_id: RunOpaqueIdSchema,
    workflow_id: z.string().min(1).max(256),
    attempt: z.literal(1),
    started_at: StudioRunTimestampSchema,
    source: z.string().min(1).max(256),
    event: z.string().min(1).max(256),
    action: z.string().min(1).max(256).optional(),
    route_target: RouteTargetSchema
  })
  .strict();

const NativeStudioQueuedRunShape = {
  schema_version: z.literal(1),
  run_id: RunOpaqueIdSchema,
  accepted_plan_id: StudioRunPlanIdSchema,
  accepted_at: StudioRunTimestampSchema,
  idempotency_binding_hash: StudioDigestSchema,
  execution_snapshot_hash: StudioDigestSchema,
  execution_snapshot: StudioRunExecutionSnapshotSchema,
  catalog_fingerprint: StudioDigestSchema,
  request: StudioRunPlanRequestSchema,
  run: NativeStudioQueuedRunHandleSchema,
  preallocation: PreallocateRunInputSchema,
  snapshot: NativeStudioRunSnapshotManifestSchema
} as const;

const NativeStudioQueuedRunBaseSchema = z
  .object(NativeStudioQueuedRunShape)
  .strict();
type NativeStudioQueuedRunBase = z.infer<
  typeof NativeStudioQueuedRunBaseSchema
>;

function sameInputProvenance(
  left: NativeStudioQueuedRunBase["request"]["input_provenance"],
  right: NativeStudioQueuedRunBase["preallocation"]["input_provenance"]
): boolean {
  if (right === undefined || left.kind !== right.kind) {
    return false;
  }
  return left.kind === "invocation" || (
    right.kind === "adapter" &&
    left.adapter_id === right.adapter_id &&
    left.adapter_input_hash === right.adapter_input_hash
  );
}

function validateQueuedRun(
  job: NativeStudioQueuedRunBase,
  context: z.RefinementCtx
): void {
  if (
    job.run_id !== job.run.run_id ||
    job.run_id !== job.preallocation.run_id
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["run_id"],
      message: "Queued run ids must match"
    });
  }
  if (job.accepted_plan_id !== job.preallocation.accepted_plan_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["preallocation", "accepted_plan_id"],
      message: "Queued accepted plan ids must match"
    });
  }
  if (!sameInputProvenance(
    job.request.input_provenance,
    job.preallocation.input_provenance
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["preallocation", "input_provenance"],
      message: "Queued input provenance must match"
    });
  }
  const legacyStandardProfile =
    job.preallocation.execution_profile === undefined &&
    job.preallocation.execution_profile_hash === undefined &&
    job.execution_snapshot.execution_profile.kind === "standard" &&
    job.execution_snapshot.execution_profile_hash ===
      STUDIO_STANDARD_EXECUTION_PROFILE_HASH;
  if (!legacyStandardProfile && (
    job.preallocation.execution_profile_hash !==
      job.execution_snapshot.execution_profile_hash ||
    sha256Digest(job.preallocation.execution_profile) !==
      sha256Digest(job.execution_snapshot.execution_profile)
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["preallocation", "execution_profile"],
      message: "Queued execution profiles must match"
    });
  }
  if (
    job.request.workflow_id !== job.run.workflow_id ||
    job.request.workflow_id !== job.preallocation.workflow_id ||
    job.request.workflow_id !== job.snapshot.workflow_id
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["request", "workflow_id"],
      message: "Queued workflow ids must match"
    });
  }
  if (
    job.execution_snapshot_hash !==
      job.preallocation.definition.execution_snapshot_hash ||
    job.execution_snapshot_hash !==
      job.execution_snapshot.execution_snapshot_hash
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["execution_snapshot_hash"],
      message: "Queued execution snapshot hashes must match"
    });
  }
  if (
    job.catalog_fingerprint !==
      job.preallocation.definition.catalog_fingerprint ||
    job.catalog_fingerprint !== job.execution_snapshot.catalog_fingerprint
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["catalog_fingerprint"],
      message: "Queued catalog fingerprints must match"
    });
  }
  if (
    job.execution_snapshot.workflow_id !== job.request.workflow_id ||
    job.execution_snapshot.workflow_revision !==
      job.preallocation.definition.workflow_revision ||
    job.execution_snapshot.definition_bundle_hash !==
      job.preallocation.definition.definition_bundle_hash
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["execution_snapshot"],
      message: "Queued execution definition metadata must match"
    });
  }
  if (!workflowExecutionScopesEqual(
    job.execution_snapshot.execution_scope,
    job.request.execution_scope
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["execution_snapshot", "execution_scope"],
      message: "Queued execution scopes must match"
    });
  }
  if (
    job.execution_snapshot.repository_id !==
      job.preallocation.repository_id
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["execution_snapshot", "repository_id"],
      message: "Queued repository ids must match"
    });
  }
}

const NativeStudioQueuedRunMaterialSchema = z
  .object(NativeStudioQueuedRunShape).strict()
  .superRefine(validateQueuedRun);

export type NativeStudioQueuedRunMaterial = z.infer<
  typeof NativeStudioQueuedRunMaterialSchema
>;

export const NativeStudioQueuedRunSchema = z
  .object({
    ...NativeStudioQueuedRunShape,
    command_hash: StudioDigestSchema
  })
  .strict()
  .superRefine(validateQueuedRun);
export type NativeStudioQueuedRun = z.infer<
  typeof NativeStudioQueuedRunSchema
>;

export function nativeStudioQueuedRunMaterial(
  job: NativeStudioQueuedRun
): NativeStudioQueuedRunMaterial {
  const { command_hash: _commandHash, ...material } = job;
  return NativeStudioQueuedRunMaterialSchema.parse(material);
}

export { NativeStudioQueuedRunMaterialSchema };
