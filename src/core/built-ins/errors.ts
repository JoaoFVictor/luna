export type BuiltInErrorCode =
  | "built_in_duplicate"
  | "built_in_input_invalid"
  | "built_in_input_missing"
  | "built_in_dependency_missing"
  | "built_in_output_invalid"
  | "built_in_state_missing"
  | "built_in_unsupported";

export function builtInError(
  message: string,
  code: BuiltInErrorCode
): Error & { code: BuiltInErrorCode } {
  const error = new Error(message) as Error & { code: BuiltInErrorCode };
  error.code = code;

  return error;
}
