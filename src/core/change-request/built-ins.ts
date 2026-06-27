import { defineBuiltInStep } from "../built-ins/registry.js";
import { changeRequestCreateMetadata } from "../built-ins/metadata.js";
import type {
  BuiltInStep,
  BuiltInStepRunOptions
} from "../built-ins/types.js";
import type {
  ChangeRequestBuiltInPorts,
  ChangeRequestCreateInput,
  ChangeRequestCreateResult,
  ChangeRequestSkippedResult,
  ChangeRequestSourceInput,
  ChangeRequestState
} from "./contracts.js";

export type ChangeRequestBuiltInPortResolver =
  | ChangeRequestBuiltInPorts
  | ((options: BuiltInStepRunOptions) => ChangeRequestBuiltInPorts);

function changeRequestError(
  message: string,
  code: string
): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function resolvePorts(
  resolver: ChangeRequestBuiltInPortResolver,
  options: BuiltInStepRunOptions
): ChangeRequestBuiltInPorts {
  return typeof resolver === "function" ? resolver(options) : resolver;
}

export function changeRequestPortsFromBuiltInOptions({
  dependencies = {}
}: BuiltInStepRunOptions): ChangeRequestBuiltInPorts {
  const { changeRequest } = dependencies;

  if (changeRequest === undefined) {
    throw changeRequestError(
      "Change request ports are not configured for this runtime.",
      "change_request_port_unavailable"
    );
  }

  return changeRequest;
}

function readEnabled(
  input: Record<string, unknown> | undefined
): boolean {
  if (
    input?.operation_id !== undefined &&
    input.operation_id !== "change-request.create"
  ) {
    throw changeRequestError(
      "Change request operation_id is invalid.",
      "change_request_input_invalid"
    );
  }
  if (input?.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw changeRequestError(
      "Change request enabled must be a boolean.",
      "change_request_input_invalid"
    );
  }
  return input?.enabled ?? true;
}

function skipped(reason: string, enabled = true): ChangeRequestSkippedResult {
  return {
    operation_id: "change-request.create",
    enabled,
    skipped: true,
    reason,
    adopted: false
  };
}

function isSkippedResult(
  result: ChangeRequestCreateInput | ChangeRequestSkippedResult
): result is ChangeRequestSkippedResult {
  return "skipped" in result && result.skipped === true;
}

function readSource(
  input: Record<string, unknown> | undefined
): ChangeRequestSourceInput | undefined {
  if (input?.source === undefined) {
    return undefined;
  }
  if (
    typeof input.source !== "object" ||
    input.source === null ||
    Array.isArray(input.source)
  ) {
    throw changeRequestError(
      "Change request source must be an object.",
      "change_request_input_invalid"
    );
  }

  const source = input.source as Record<string, unknown>;
  if (source.enabled !== undefined && typeof source.enabled !== "boolean") {
    throw changeRequestError(
      "Change request source enabled must be a boolean.",
      "change_request_input_invalid"
    );
  }
  if (source.skipped !== undefined && typeof source.skipped !== "boolean") {
    throw changeRequestError(
      "Change request source skipped must be a boolean.",
      "change_request_input_invalid"
    );
  }
  if (source.branch !== undefined && typeof source.branch !== "string") {
    throw changeRequestError(
      "Change request source branch must be a string.",
      "change_request_input_invalid"
    );
  }
  if (source.reason !== undefined && typeof source.reason !== "string") {
    throw changeRequestError(
      "Change request source reason must be a string.",
      "change_request_input_invalid"
    );
  }

  return {
    ...(source.enabled === undefined ? {} : { enabled: source.enabled }),
    ...(source.skipped === undefined ? {} : { skipped: source.skipped }),
    ...(source.branch === undefined ? {} : { branch: source.branch }),
    ...(source.reason === undefined ? {} : { reason: source.reason })
  };
}

function createEnabledInputFrom(
  input: Record<string, unknown> | undefined
): ChangeRequestCreateInput | ChangeRequestSkippedResult {
  if (typeof input?.provider_id !== "string" || input.provider_id === "") {
    throw changeRequestError(
      "Change request provider_id is required.",
      "change_request_input_invalid"
    );
  }
  if (
    typeof input.repository_path !== "string" ||
    input.repository_path === ""
  ) {
    throw changeRequestError(
      "Change request repository_path is required.",
      "change_request_input_invalid"
    );
  }
  if (typeof input.title !== "string" || input.title === "") {
    throw changeRequestError(
      "Change request title is required.",
      "change_request_input_invalid"
    );
  }
  const source = readSource(input);
  if (source?.skipped === true) {
    return skipped(source.reason ?? "source_not_published");
  }
  const sourceBranch =
    typeof input.source_branch === "string" && input.source_branch !== ""
      ? input.source_branch
      : source?.branch;
  if (sourceBranch === undefined || sourceBranch === "") {
    return skipped("source_branch_missing");
  }
  if (
    input.description !== undefined &&
    typeof input.description !== "string"
  ) {
    throw changeRequestError(
      "Change request description must be a string.",
      "change_request_input_invalid"
    );
  }
  if (typeof input.target_branch !== "string" || input.target_branch === "") {
    throw changeRequestError(
      "Change request target_branch is required.",
      "change_request_input_invalid"
    );
  }
  if (input.draft !== undefined && typeof input.draft !== "boolean") {
    throw changeRequestError(
      "Change request draft must be a boolean.",
      "change_request_input_invalid"
    );
  }

  return {
    operation_id: "change-request.create",
    enabled: true,
    provider_id: input.provider_id,
    repository_path: input.repository_path,
    title: input.title,
    source_branch: sourceBranch,
    ...(source === undefined ? {} : { source }),
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    target_branch: input.target_branch,
    ...(input.draft === undefined ? {} : { draft: input.draft })
  };
}

function compatibleState(
  existing: ChangeRequestState | undefined,
  input: ChangeRequestCreateInput
): ChangeRequestCreateResult | undefined {
  if (
    existing?.operation_id !== "change-request.create" ||
    existing.provider_id !== input.provider_id ||
    existing.title !== input.title ||
    existing.source_branch !== input.source_branch ||
    existing.target_branch !== input.target_branch
  ) {
    return undefined;
  }

  return {
    ...existing,
    enabled: true,
    skipped: false,
    provider: existing.provider_id,
    adopted: true
  };
}

export function createChangeRequestCreateBuiltIn(
  ports: ChangeRequestBuiltInPortResolver
): BuiltInStep<"change-request.create"> {
  return defineBuiltInStep({
    name: "change-request.create",
    metadata: changeRequestCreateMetadata,
    async run(options) {
      if (!readEnabled(options.input)) {
        return skipped("disabled", false);
      }
      const input = createEnabledInputFrom(options.input);
      if (isSkippedResult(input)) {
        return input;
      }
      const provider = resolvePorts(ports, options).providers.get(
        input.provider_id
      );
      const existing = await provider.readChangeRequest(input);
      const adopted = compatibleState(existing, input);

      if (adopted !== undefined) {
        return adopted;
      }

      try {
        return await provider.createChangeRequest(input);
      } catch (error) {
        try {
          const recovered = compatibleState(
            await provider.readChangeRequest(input),
            input
          );
          if (recovered !== undefined) {
            return recovered;
          }
        } catch {
          // Preserve the original write failure when recovery cannot inspect state.
        }

        throw error;
      }
    }
  });
}
