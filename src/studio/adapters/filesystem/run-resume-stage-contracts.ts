import { z } from "zod";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import { StudioDigestSchema } from "../../contracts/digests.js";
import { RunOpaqueIdSchema } from "../../contracts/runs.js";

const ResumeStageShape = {
  schema_version: z.literal(1),
  resume_id: RunOpaqueIdSchema,
  command_hash: StudioDigestSchema,
  stage: z.enum(["pre_execution", "effect_may_have_occurred"]),
  effect_node_id: z.string().trim().min(1).max(256).optional()
} as const;

function validateStage(
  stage: { readonly stage: string; readonly effect_node_id?: string },
  context: z.RefinementCtx
): void {
  if (
    (stage.stage === "pre_execution") !==
    (stage.effect_node_id === undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["effect_node_id"],
      message: "Resume effect node must exist only after an effect may have occurred"
    });
  }
}

const ResumeStageMaterialSchema = z.object(ResumeStageShape)
  .strict()
  .superRefine(validateStage);

export const NativeStudioRunResumeStageSchema =
  z.object({
    ...ResumeStageShape,
    stage_hash: StudioDigestSchema
  }).strict().superRefine((stage, context) => {
    validateStage(stage, context);
    const { stage_hash: _stageHash, ...material } = stage;
    if (stage.stage_hash !== sha256Digest(material)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stage_hash"],
        message: "Resume execution stage failed integrity validation"
      });
    }
  });

export type NativeStudioRunResumeStage = z.infer<
  typeof NativeStudioRunResumeStageSchema
>;

export function nativeStudioRunResumeStage(input: {
  readonly resumeId: string;
  readonly commandHash: string;
  readonly stage: "pre_execution" | "effect_may_have_occurred";
  readonly effectNodeId?: string;
}): NativeStudioRunResumeStage {
  const material = ResumeStageMaterialSchema.parse({
    schema_version: 1,
    resume_id: input.resumeId,
    command_hash: input.commandHash,
    stage: input.stage,
    ...(input.effectNodeId === undefined
      ? {}
      : { effect_node_id: input.effectNodeId })
  });
  return NativeStudioRunResumeStageSchema.parse({
    ...material,
    stage_hash: sha256Digest(material)
  });
}
