import { gitStatusMetadata } from "../../core/built-ins/metadata.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import type {
  BuiltInStep,
  BuiltInStepRunOptions
} from "../../core/built-ins/types.js";
import type { GitStatusInput } from "./contracts.js";
import {
  gitError,
  type GitBuiltInPortResolver,
  resolvePorts,
  workspaceFrom
} from "./shared.js";

type GitStatusBuiltInInput = {
  readonly operation_id: "git.status";
};

function statusInputFrom(
  input: Record<string, unknown> | undefined,
  state: BuiltInStepRunOptions["state"]
): GitStatusInput {
  if (input?.operation_id !== undefined && input.operation_id !== "git.status") {
    throw gitError("Git status operation_id is invalid.", "git_input_invalid");
  }

  const statusInput: GitStatusBuiltInInput = {
    operation_id: "git.status"
  };

  return {
    ...statusInput,
    workspace: workspaceFrom(state)
  };
}

export function createGitStatusBuiltIn(
  ports: GitBuiltInPortResolver
): BuiltInStep<"git.status"> {
  return defineBuiltInStep({
    name: "git.status",
    metadata: gitStatusMetadata,
    async run(options) {
      const input = statusInputFrom(options.input, options.state);
      return await resolvePorts(ports, options).repository.status(input);
    }
  });
}
