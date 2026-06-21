import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);

export const ValidationCommandResultSchema = z
  .object({
    cmd: NonEmptyStringSchema,
    args: z.array(z.string()).optional(),
    exit_code: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    stdout_truncated: z.boolean(),
    stderr_truncated: z.boolean(),
    duration_ms: z.number().int().nonnegative(),
    timed_out: z.boolean()
  })
  .strict();
export type ValidationCommandResult = z.infer<
  typeof ValidationCommandResultSchema
>;

export const ValidationResultSchema = z
  .object({
    passed: z.boolean(),
    commands: z.array(ValidationCommandResultSchema).optional()
  })
  .strict();
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

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
