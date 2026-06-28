import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);

export const ValidationCommandSchema = z
  .object({
    cmd: NonEmptyStringSchema,
    args: z.array(z.string()).optional(),
    timeout_ms: z.number().int().positive().optional()
  })
  .strict();
export type ValidationCommand = z.infer<typeof ValidationCommandSchema>;

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
