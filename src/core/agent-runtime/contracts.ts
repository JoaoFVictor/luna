import { z } from "zod";
import { ValidationResultSchema } from "../validation/runner.js";

const NonEmptyStringSchema = z.string().min(1);

export const AgentLoopAttemptSchema = z
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
    diff_summary: z.unknown().optional(),
    duration_ms: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional()
  })
  .strict();
export type AgentLoopAttempt = z.infer<typeof AgentLoopAttemptSchema>;

export const AgentLoopResultSchema = z
  .object({
    status: z.enum(["passed", "failed"]),
    attempts_exhausted: z.boolean(),
    attempts: z.array(AgentLoopAttemptSchema),
    validation: ValidationResultSchema,
    final_validation: ValidationResultSchema,
    result: z
      .object({
        status: NonEmptyStringSchema
      })
      .passthrough()
  })
  .strict();
export type AgentLoopResult = z.infer<typeof AgentLoopResultSchema>;
