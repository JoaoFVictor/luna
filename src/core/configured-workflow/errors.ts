import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);

export const ErrorArtifactSchema = z
  .object({
    run_id: NonEmptyStringSchema.optional(),
    message: NonEmptyStringSchema,
    code: NonEmptyStringSchema.optional(),
    details: z.record(z.unknown()).optional()
  })
  .strict();
export type ErrorArtifact = z.infer<typeof ErrorArtifactSchema>;

export function configuredWorkflowError(
  message: string,
  code: string,
  cause?: unknown
): Error & { code: string } {
  const error = new Error(message, { cause }) as Error & { code: string };
  error.code = code;

  return error;
}

export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && code !== "" ? code : "unknown_error";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }

  return String(error);
}

export function errorArtifact(
  runId: string,
  error: unknown
): ErrorArtifact {
  const details = (error as { details?: ErrorArtifact["details"] })?.details;

  return {
    run_id: runId,
    code: errorCode(error),
    message: errorMessage(error),
    ...(details === undefined ? {} : { details })
  };
}
