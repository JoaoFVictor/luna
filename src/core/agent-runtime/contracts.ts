import { z } from "zod";
import { ValidationResultSchema } from "../validation/runner.js";

const NonEmptyStringSchema = z.string().min(1);

export const GateResultSchema = z
  .object({
    id: NonEmptyStringSchema,
    type: NonEmptyStringSchema,
    passed: z.boolean(),
    feedback: z.string().optional(),
    output: z.unknown().optional()
  })
  .strict();
export type GateResult = z.infer<typeof GateResultSchema>;

export const GatedAgentLoopAttemptSchema = z
  .object({
    attempt: z.number().int().positive(),
    phase: z.enum(["initial", "repair"]),
    agent_output: z.unknown().optional(),
    agent_error: z
      .object({
        message: NonEmptyStringSchema,
        code: NonEmptyStringSchema.optional()
      })
      .strict()
      .optional(),
    validation: ValidationResultSchema.optional(),
    gate_results: z.array(GateResultSchema).optional(),
    diff_summary: z.unknown().optional(),
    duration_ms: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional()
  })
  .strict();
export type GatedAgentLoopAttempt = z.infer<typeof GatedAgentLoopAttemptSchema>;

export const GatedAgentLoopResultSchema = z
  .object({
    status: z.enum(["passed", "failed"]),
    attempts_exhausted: z.boolean(),
    attempts: z.array(GatedAgentLoopAttemptSchema),
    validation: ValidationResultSchema,
    final_validation: ValidationResultSchema,
    gates: z.array(GateResultSchema),
    result: z
      .object({
        status: NonEmptyStringSchema
      })
      .passthrough()
  })
  .strict();
export type GatedAgentLoopResult = z.infer<typeof GatedAgentLoopResultSchema>;
