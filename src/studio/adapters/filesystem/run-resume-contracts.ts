import { z } from "zod";
import { boundedStudioJsonValueSchema } from "../../contracts/bounded-json.js";
import { StudioDigestSchema } from "../../contracts/digests.js";
import { StudioRunTimestampSchema } from "../../contracts/run-launch-primitives.js";
import { RunOpaqueIdSchema } from "../../contracts/runs.js";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";

const ResumeDecisionSchema = boundedStudioJsonValueSchema({
  maxBytes: 32_768,
  maxDepth: 12,
  maxEntries: 256,
  maxKeyLength: 128
});

const NativeStudioQueuedResumeShape = {
  schema_version: z.literal(1),
  resume_id: RunOpaqueIdSchema,
  run_id: RunOpaqueIdSchema,
  interrupt_id: RunOpaqueIdSchema,
  thread_id: RunOpaqueIdSchema,
  checkpoint_id: RunOpaqueIdSchema,
  workflow_id: z.string().trim().min(1).max(256),
  owner_id: z.string().trim().min(1).max(256),
  execution_snapshot_hash: StudioDigestSchema,
  decision: ResumeDecisionSchema,
  decision_hash: StudioDigestSchema,
  accepted_at: StudioRunTimestampSchema
} as const;

export const NativeStudioQueuedResumeMaterialSchema = z.object(
  NativeStudioQueuedResumeShape
).strict().superRefine((job, context) => {
  if (job.decision_hash !== sha256Digest(job.decision)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["decision_hash"],
      message: "Queued resume decision hash does not match its decision"
    });
  }
});

export type NativeStudioQueuedResumeMaterial = z.infer<
  typeof NativeStudioQueuedResumeMaterialSchema
>;

export const NativeStudioQueuedResumeSchema = z.object({
  ...NativeStudioQueuedResumeShape,
  command_hash: StudioDigestSchema
}).strict().superRefine((job, context) => {
  if (job.decision_hash !== sha256Digest(job.decision)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["decision_hash"],
      message: "Queued resume decision hash does not match its decision"
    });
  }
  const { command_hash: _commandHash, ...material } = job;
  if (job.command_hash !== sha256Digest(material)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["command_hash"],
      message: "Queued resume command failed integrity validation"
    });
  }
});

export type NativeStudioQueuedResume = z.infer<
  typeof NativeStudioQueuedResumeSchema
>;

export function nativeStudioQueuedResumeMaterial(
  job: NativeStudioQueuedResume
): NativeStudioQueuedResumeMaterial {
  const { command_hash: _commandHash, ...material } = job;
  return NativeStudioQueuedResumeMaterialSchema.parse(material);
}
