import { z } from "zod";
import { WorkflowIdSchema } from "../../core/router/invocation.js";
import { boundedStudioJsonValueSchema } from "./bounded-json.js";
import { StudioDigestSchema } from "./digests.js";
import { StudioInvocationSchema } from "./input-routing.js";
import {
  STUDIO_RUN_EFFECT_LIMITS,
  StudioRunEffectUncertaintySchema,
  StudioRunPlanWarningSchema,
  StudioRunPotentialEffectSchema,
  StudioRunResolvedEffectSchema,
  studioRunEffectsRequireConfirmation,
  validateStudioRunEffects
} from "./run-launch-effects.js";
import {
  StudioRunBoundedIdSchema,
  StudioRunPlanIdSchema,
  StudioRunTimestampSchema
} from "./run-launch-primitives.js";
import {
  StudioRunInputProvenanceSchema
} from "./run-provenance.js";
import { RunOpaqueIdSchema } from "./runs.js";

export {
  StudioRunEffectCategorySchema,
  StudioRunEffectUncertaintySchema,
  StudioRunPlanWarningSchema,
  StudioRunPotentialEffectSchema,
  StudioRunResolvedEffectSchema,
  type StudioRunEffectCategory,
  type StudioRunEffectUncertainty,
  type StudioRunPlanWarning,
  type StudioRunPotentialEffect,
  type StudioRunResolvedEffect
} from "./run-launch-effects.js";

export const STUDIO_RUN_LAUNCH_LIMITS = Object.freeze({
  invocation: Object.freeze({
    maxBytes: 1_048_576,
    maxDepth: 32,
    maxEntries: 20_000,
    maxKeyLength: 256
  }),
  config: Object.freeze({
    maxBytes: 524_288,
    maxDepth: 32,
    maxEntries: 10_000,
    maxKeyLength: 256
  }),
  ...STUDIO_RUN_EFFECT_LIMITS
} as const);

export { StudioRunPlanIdSchema } from "./run-launch-primitives.js";
export {
  StudioRunInputProvenanceSchema,
  type StudioRunInputProvenance
} from "./run-provenance.js";

export const StudioRunConfirmationTokenSchema = z
  .string()
  .min(43)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

export const StudioRunModeSchema = z.enum([
  "read_only",
  "trusted_local_write"
]);
export type StudioRunMode = z.infer<typeof StudioRunModeSchema>;

export const StudioRunInvocationSchema = boundedStudioJsonValueSchema(
  STUDIO_RUN_LAUNCH_LIMITS.invocation
).pipe(StudioInvocationSchema);

const StudioRunConfigSchema = boundedStudioJsonValueSchema(
  STUDIO_RUN_LAUNCH_LIMITS.config
);

export const StudioRunPlanRequestSchema = z
  .object({
    workflow_id: WorkflowIdSchema,
    invocation: StudioRunInvocationSchema,
    config: StudioRunConfigSchema,
    input_provenance: StudioRunInputProvenanceSchema.default({
      kind: "invocation"
    }),
    repository_id: StudioRunBoundedIdSchema.optional()
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.invocation.target !== undefined &&
      request.invocation.target.id !== request.workflow_id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["invocation", "target", "id"],
        message: "Invocation target must match the requested workflow"
      });
    }
  });
export type StudioRunPlanRequest = z.infer<
  typeof StudioRunPlanRequestSchema
>;
export type StudioRunPlanRequestInput = z.input<
  typeof StudioRunPlanRequestSchema
>;

const StudioRunRepositoryResolutionSchema = z
  .object({
    required: z.boolean(),
    repository_id: StudioRunBoundedIdSchema.optional(),
    fingerprint: StudioDigestSchema.optional()
  })
  .strict()
  .superRefine((repository, context) => {
    if (
      (repository.repository_id === undefined) !==
      (repository.fingerprint === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Repository id and fingerprint must appear together"
      });
    }
    if (repository.required && repository.fingerprint === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fingerprint"],
        message: "Required repositories must be fingerprinted"
      });
    }
  });

export const StudioRunPlanResolutionSchema = z
  .object({
    workflow_id: WorkflowIdSchema,
    mode: StudioRunModeSchema,
    workflow_revision: StudioDigestSchema,
    definition_bundle_hash: StudioDigestSchema,
    catalog_fingerprint: StudioDigestSchema,
    repository: StudioRunRepositoryResolutionSchema,
    potential_effects: z
      .array(StudioRunPotentialEffectSchema)
      .max(STUDIO_RUN_LAUNCH_LIMITS.maxPotentialEffects),
    resolved_effects: z
      .array(StudioRunResolvedEffectSchema)
      .max(STUDIO_RUN_LAUNCH_LIMITS.maxResolvedEffects),
    effect_uncertainties: z
      .array(StudioRunEffectUncertaintySchema)
      .max(STUDIO_RUN_LAUNCH_LIMITS.maxEffectUncertainties),
    warnings: z
      .array(StudioRunPlanWarningSchema)
      .max(STUDIO_RUN_LAUNCH_LIMITS.maxWarnings)
  })
  .strict()
  .superRefine(validateStudioRunEffects);
export type StudioRunPlanResolution = z.infer<
  typeof StudioRunPlanResolutionSchema
>;

export const StudioRunExecutionSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    workflow_id: WorkflowIdSchema,
    mode: StudioRunModeSchema,
    workflow_revision: StudioDigestSchema,
    definition_bundle_hash: StudioDigestSchema,
    catalog_fingerprint: StudioDigestSchema,
    invocation_hash: StudioDigestSchema,
    config_hash: StudioDigestSchema,
    repository_required: z.boolean(),
    repository_id: StudioRunBoundedIdSchema.optional(),
    repository_fingerprint: StudioDigestSchema.optional(),
    input_provenance: StudioRunInputProvenanceSchema,
    execution_snapshot_hash: StudioDigestSchema
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      (snapshot.repository_id === undefined) !==
      (snapshot.repository_fingerprint === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Repository id and fingerprint must appear together"
      });
    }
    if (snapshot.repository_required && snapshot.repository_fingerprint === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repository_fingerprint"],
        message: "Required repositories must be fingerprinted"
      });
    }
  });
export type StudioRunExecutionSnapshot = z.infer<
  typeof StudioRunExecutionSnapshotSchema
>;

export const StudioRunPlanSchema = z
  .object({
    plan_id: StudioRunPlanIdSchema,
    created_at: StudioRunTimestampSchema,
    expires_at: StudioRunTimestampSchema,
    workflow_id: WorkflowIdSchema,
    mode: StudioRunModeSchema,
    workflow_revision: StudioDigestSchema,
    definition_bundle_hash: StudioDigestSchema,
    catalog_fingerprint: StudioDigestSchema,
    execution_snapshot_hash: StudioDigestSchema,
    invocation_hash: StudioDigestSchema,
    config_hash: StudioDigestSchema,
    repository_required: z.boolean(),
    repository_id: StudioRunBoundedIdSchema.optional(),
    repository_fingerprint: StudioDigestSchema.optional(),
    input_provenance: StudioRunInputProvenanceSchema,
    potential_effects: z
      .array(StudioRunPotentialEffectSchema)
      .max(STUDIO_RUN_LAUNCH_LIMITS.maxPotentialEffects),
    resolved_effects: z
      .array(StudioRunResolvedEffectSchema)
      .max(STUDIO_RUN_LAUNCH_LIMITS.maxResolvedEffects),
    effect_uncertainties: z
      .array(StudioRunEffectUncertaintySchema)
      .max(STUDIO_RUN_LAUNCH_LIMITS.maxEffectUncertainties),
    warnings: z
      .array(StudioRunPlanWarningSchema)
      .max(STUDIO_RUN_LAUNCH_LIMITS.maxWarnings),
    confirmation_required: z.boolean(),
    confirmation_token: StudioRunConfirmationTokenSchema
  })
  .strict()
  .superRefine((plan, context) => {
    validateStudioRunEffects(plan, context);
    if (
      (plan.repository_id === undefined) !==
      (plan.repository_fingerprint === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Repository id and fingerprint must appear together"
      });
    }
    if (plan.repository_required && plan.repository_fingerprint === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repository_fingerprint"],
        message: "Required repositories must be fingerprinted"
      });
    }
    if (Date.parse(plan.expires_at) <= Date.parse(plan.created_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expires_at"],
        message: "Run plan expiry must follow creation"
      });
    }
    const confirmationRequired = studioRunEffectsRequireConfirmation(plan);
    if (confirmationRequired !== plan.confirmation_required) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmation_required"],
        message: "Confirmation requirement must match the effect analysis"
      });
    }
  });
export type StudioRunPlan = z.infer<typeof StudioRunPlanSchema>;

export const StudioRunLaunchContextSchema = z
  .object({
    actor_id: StudioRunBoundedIdSchema,
    actor_binding: z.string().min(16).max(512),
    request_id: RunOpaqueIdSchema
  })
  .strict();
export type StudioRunLaunchContext = z.infer<
  typeof StudioRunLaunchContextSchema
>;

export const StudioRunExecuteRequestSchema = z
  .object({
    confirmation_token: StudioRunConfirmationTokenSchema,
    idempotency_key: z
      .string()
      .min(8)
      .max(256)
      .regex(/^[\x21-\x7e]+$/),
    confirmation: z
      .object({
        kind: z.literal("local_explicit"),
        real_run_confirmed: z.literal(true),
        listed_effects_confirmed: z.literal(true)
      })
      .strict()
  })
  .strict();
export type StudioRunExecuteRequest = z.infer<
  typeof StudioRunExecuteRequestSchema
>;

export const StudioRunDispatchReceiptSchema = z
  .object({
    accepted: z.literal(true),
    dispatch_status: z.literal("queued"),
    run_id: RunOpaqueIdSchema,
    plan_id: StudioRunPlanIdSchema,
    execution_snapshot_hash: StudioDigestSchema,
    accepted_at: StudioRunTimestampSchema
  })
  .strict();
export type StudioRunDispatchReceipt = z.infer<
  typeof StudioRunDispatchReceiptSchema
>;
