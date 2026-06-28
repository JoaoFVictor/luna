import type { BuiltInStepMetadata } from "../../core/built-ins/types.js";
import { ValidationResultSchema } from "./command-runner.js";

function lifecycleContractError(message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = "built_in_lifecycle_contract_invalid";

  return error;
}

export const runValidationCommandsMetadata = Object.freeze({
  implementationLifecycle: "validation",
  implementationLifecycleOutcome: (output) => {
    const result = ValidationResultSchema.safeParse(output);
    if (!result.success) {
      throw lifecycleContractError(
        "validation.run_commands must return ValidationResult"
      );
    }

    return { validationPassed: result.data.passed };
  }
} satisfies BuiltInStepMetadata);
