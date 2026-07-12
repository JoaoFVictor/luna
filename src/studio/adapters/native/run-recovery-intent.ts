import { z } from "zod";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import { StudioDigestSchema } from "../../contracts/digests.js";
import { RunOpaqueIdSchema } from "../../contracts/runs.js";

export const NativeStudioRunRecoveryReasonSchema = z.enum([
  "runtime_durability_recovery_required",
  "success_barrier_recovery_required"
]);

const RecoveryIntentMaterialSchema = z.object({
  schema_version: z.literal(1),
  run_id: RunOpaqueIdSchema,
  execution_snapshot_hash: StudioDigestSchema,
  reason: NativeStudioRunRecoveryReasonSchema
}).strict();

export const NativeStudioRunRecoveryIntentSchema =
  RecoveryIntentMaterialSchema.extend({
    intent_hash: StudioDigestSchema
  }).strict().superRefine((intent, context) => {
    const material = {
      schema_version: intent.schema_version,
      run_id: intent.run_id,
      execution_snapshot_hash: intent.execution_snapshot_hash,
      reason: intent.reason
    };
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
  readonly reason: NativeStudioRunRecoveryReason;
}): NativeStudioRunRecoveryIntent {
  const material = RecoveryIntentMaterialSchema.parse({
    schema_version: 1,
    run_id: input.runId,
    execution_snapshot_hash: input.executionSnapshotHash,
    reason: input.reason
  });
  return NativeStudioRunRecoveryIntentSchema.parse({
    ...material,
    intent_hash: sha256Digest(material)
  });
}
