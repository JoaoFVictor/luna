import type { BuiltInStepMetadata } from "../../core/built-ins/types.js";
import { ChangeRequestArtifactSchema } from "./contracts.js";

function lifecycleContractError(message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = "built_in_lifecycle_contract_invalid";

  return error;
}

function repositoryLock(): { resource: "repository"; mode: "exclusive" } {
  return { resource: "repository", mode: "exclusive" };
}

export const changeRequestCreateMetadata = Object.freeze({
  implementationLifecycle: "change_request",
  requiresRepository: true,
  implementationLifecycleOutcome: (output) => {
    const result = ChangeRequestArtifactSchema.safeParse(output);
    if (!result.success) {
      throw lifecycleContractError(
        "change-request.create must return ChangeRequestArtifact"
      );
    }

    return {
      changeRequestAttempted:
        !result.data.skipped && result.data.url !== undefined
    };
  },
  locks: Object.freeze([repositoryLock()])
} satisfies BuiltInStepMetadata);
