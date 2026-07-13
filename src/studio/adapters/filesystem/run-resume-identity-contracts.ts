import { z } from "zod";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import { StudioDigestSchema } from "../../contracts/digests.js";
import { RunOpaqueIdSchema } from "../../contracts/runs.js";
import { StudioRunTimestampSchema } from "../../contracts/run-launch-primitives.js";

const Shape = {
  schema_version: z.literal(1),
  resume_id: RunOpaqueIdSchema,
  run_id: RunOpaqueIdSchema,
  interrupt_id: RunOpaqueIdSchema,
  command_hash: StudioDigestSchema,
  accepted_at: StudioRunTimestampSchema
} as const;

export const NativeStudioRunResumeIdentitySchema = z.object({
  ...Shape,
  identity_hash: StudioDigestSchema
}).strict().superRefine((identity, context) => {
  const { identity_hash: _hash, ...material } = identity;
  if (identity.identity_hash !== sha256Digest(material)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["identity_hash"],
      message: "Resume identity failed integrity validation"
    });
  }
});

export type NativeStudioRunResumeIdentity = z.infer<
  typeof NativeStudioRunResumeIdentitySchema
>;

export function nativeStudioRunResumeIdentity(input: {
  readonly resumeId: string;
  readonly runId: string;
  readonly interruptId: string;
  readonly commandHash: string;
  readonly acceptedAt: string;
}): NativeStudioRunResumeIdentity {
  const material = {
    schema_version: 1 as const,
    resume_id: input.resumeId,
    run_id: input.runId,
    interrupt_id: input.interruptId,
    command_hash: input.commandHash,
    accepted_at: input.acceptedAt
  };
  return NativeStudioRunResumeIdentitySchema.parse({
    ...material,
    identity_hash: sha256Digest(material)
  });
}
