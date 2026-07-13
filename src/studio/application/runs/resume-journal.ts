import { z } from "zod";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import { boundedStudioJsonValueSchema } from "../../contracts/bounded-json.js";
import { StudioDigestSchema } from "../../contracts/digests.js";
import { StudioRunTimestampSchema } from "../../contracts/run-launch-primitives.js";
import { RunOpaqueIdSchema } from "../../contracts/runs.js";

const ResumeDecisionSchema = boundedStudioJsonValueSchema({
  maxBytes: 32_768,
  maxDepth: 12,
  maxEntries: 256,
  maxKeyLength: 128
});

const StudioRunResumeCommandShape = {
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

function validateDecisionHash(
  command: { readonly decision: unknown; readonly decision_hash: string },
  context: z.RefinementCtx
): void {
  if (command.decision_hash !== sha256Digest(command.decision)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["decision_hash"],
      message: "Resume decision hash does not match its decision"
    });
  }
}

export const StudioRunResumeCommandMaterialSchema = z.object(
  StudioRunResumeCommandShape
).strict().superRefine(validateDecisionHash);

export type StudioRunResumeCommandMaterial = z.infer<
  typeof StudioRunResumeCommandMaterialSchema
>;

function commandMaterialValue(
  command: StudioRunResumeCommandMaterial
): StudioRunResumeCommandMaterial {
  return {
    schema_version: command.schema_version,
    resume_id: command.resume_id,
    run_id: command.run_id,
    interrupt_id: command.interrupt_id,
    thread_id: command.thread_id,
    checkpoint_id: command.checkpoint_id,
    workflow_id: command.workflow_id,
    owner_id: command.owner_id,
    execution_snapshot_hash: command.execution_snapshot_hash,
    decision: command.decision,
    decision_hash: command.decision_hash,
    accepted_at: command.accepted_at
  };
}

export const StudioRunResumeCommandSchema = z.object({
  ...StudioRunResumeCommandShape,
  command_hash: StudioDigestSchema
}).strict().superRefine((command, context) => {
  validateDecisionHash(command, context);
  if (command.command_hash !== sha256Digest(commandMaterialValue(command))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["command_hash"],
      message: "Resume command failed integrity validation"
    });
  }
});

export type StudioRunResumeCommand = z.infer<
  typeof StudioRunResumeCommandSchema
>;

export const StudioRunResumeStageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pre_execution") }).strict(),
  z.object({
    kind: z.literal("effect_may_have_occurred"),
    node_id: z.string().trim().min(1).max(256)
  }).strict(),
  z.object({
    kind: z.literal("completed"),
    completed_at: StudioRunTimestampSchema,
    effect_node_id: z.string().trim().min(1).max(256).optional()
  }).strict()
]);

export type StudioRunResumeStage = z.infer<
  typeof StudioRunResumeStageSchema
>;

export const StudioRunResumeRecordSchema = z.object({
  ...StudioRunResumeCommandShape,
  command_hash: StudioDigestSchema,
  stage: StudioRunResumeStageSchema
}).strict().superRefine((record, context) => {
  validateDecisionHash(record, context);
  if (record.command_hash !== sha256Digest(commandMaterialValue(record))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["command_hash"],
      message: "Resume record command failed integrity validation"
    });
  }
  if (
    record.stage.kind === "completed" &&
    Date.parse(record.stage.completed_at) < Date.parse(record.accepted_at)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stage", "completed_at"],
      message: "Resume completion cannot precede acceptance"
    });
  }
});

export type StudioRunResumeRecord = z.infer<
  typeof StudioRunResumeRecordSchema
>;

export function studioRunResumeCommand(
  material: StudioRunResumeCommandMaterial
): StudioRunResumeCommand {
  const parsed = StudioRunResumeCommandMaterialSchema.parse(material);
  return StudioRunResumeCommandSchema.parse({
    ...parsed,
    command_hash: sha256Digest(parsed)
  });
}

export function studioRunResumeCommandMaterial(
  command: StudioRunResumeCommand
): StudioRunResumeCommandMaterial {
  return StudioRunResumeCommandMaterialSchema.parse(commandMaterialValue(command));
}

export function studioRunResumeRecord(input: {
  readonly command: StudioRunResumeCommand;
  readonly stage: StudioRunResumeStage;
}): StudioRunResumeRecord {
  return StudioRunResumeRecordSchema.parse({
    ...input.command,
    stage: input.stage
  });
}

export const MarkStudioRunResumeEffectInputSchema = z.object({
  resume_id: RunOpaqueIdSchema,
  command_hash: StudioDigestSchema,
  node_id: z.string().trim().min(1).max(256)
}).strict();

export type MarkStudioRunResumeEffectInput = z.infer<
  typeof MarkStudioRunResumeEffectInputSchema
>;

export const CompleteStudioRunResumeInputSchema = z.object({
  resume_id: RunOpaqueIdSchema,
  command_hash: StudioDigestSchema
}).strict();

export type CompleteStudioRunResumeInput = z.infer<
  typeof CompleteStudioRunResumeInputSchema
>;

export interface RunResumeJournalPort {
  accept(material: StudioRunResumeCommandMaterial): Promise<{
    readonly record: StudioRunResumeRecord;
    readonly created: boolean;
  }>;
  get(resumeId: string): Promise<StudioRunResumeRecord | undefined>;
  list(): Promise<readonly StudioRunResumeRecord[]>;
  markEffectMayHaveOccurred(
    input: MarkStudioRunResumeEffectInput
  ): Promise<StudioRunResumeRecord>;
  complete(input: CompleteStudioRunResumeInput): Promise<boolean>;
}
