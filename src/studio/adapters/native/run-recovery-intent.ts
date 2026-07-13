import { z } from "zod";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import { StudioDigestSchema } from "../../contracts/digests.js";
import { RunOpaqueIdSchema } from "../../contracts/runs.js";

export const NativeStudioRunRecoveryReasonSchema = z.enum([
  "runtime_durability_recovery_required",
  "success_barrier_recovery_required",
  "waiting_boundary_recovery_required"
]);

const RecoveryIntentBaseShape = {
  schema_version: z.literal(1),
  run_id: RunOpaqueIdSchema,
  execution_snapshot_hash: StudioDigestSchema
} as const;

const OrdinaryRecoveryIntentMaterialSchema = z.object({
  ...RecoveryIntentBaseShape,
  reason: z.enum([
    "runtime_durability_recovery_required",
    "success_barrier_recovery_required"
  ])
}).strict();

const WaitingRecoveryIntentMaterialSchema = z.object({
  ...RecoveryIntentBaseShape,
  reason: z.literal("waiting_boundary_recovery_required"),
  interrupt_id: RunOpaqueIdSchema,
  checkpoint_id: RunOpaqueIdSchema
}).strict();

const RecoveryIntentMaterialSchema = z.discriminatedUnion("reason", [
  OrdinaryRecoveryIntentMaterialSchema,
  WaitingRecoveryIntentMaterialSchema
]);

export const NativeStudioRunRecoveryIntentSchema =
  z.discriminatedUnion("reason", [
    OrdinaryRecoveryIntentMaterialSchema.extend({
      intent_hash: StudioDigestSchema
    }),
    WaitingRecoveryIntentMaterialSchema.extend({
      intent_hash: StudioDigestSchema
    })
  ]).superRefine((intent, context) => {
    const { intent_hash: _intentHash, ...material } = intent;
    if (intent.intent_hash !== sha256Digest(material)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["intent_hash"],
        message: "Recovery intent failed integrity validation"
      });
    }
  });

export type NativeStudioRunRecoveryIntent = z.infer<
  typeof NativeStudioRunRecoveryIntentSchema
>;

export type NativeStudioRunRecoveryReason = z.infer<
  typeof NativeStudioRunRecoveryReasonSchema
>;

export function createNativeStudioRunRecoveryIntent(input: {
  readonly runId: string;
  readonly executionSnapshotHash: string;
} & (
  | {
      readonly reason: Exclude<
        NativeStudioRunRecoveryReason,
        "waiting_boundary_recovery_required"
      >;
    }
  | {
      readonly reason: "waiting_boundary_recovery_required";
      readonly interruptId: string;
      readonly checkpointId: string;
    }
)): NativeStudioRunRecoveryIntent {
  const material = RecoveryIntentMaterialSchema.parse({
    schema_version: 1,
    run_id: input.runId,
    execution_snapshot_hash: input.executionSnapshotHash,
    reason: input.reason,
    ...(input.reason === "waiting_boundary_recovery_required"
      ? {
          interrupt_id: input.interruptId,
          checkpoint_id: input.checkpointId
        }
      : {})
  });
  return NativeStudioRunRecoveryIntentSchema.parse({
    ...material,
    intent_hash: sha256Digest(material)
  });
}
