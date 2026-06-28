import { runPreflight as defaultRunPreflight } from "../runtime/preflight-runner.js";
import type { Invocation } from "../../core/router/invocation.js";
import type { RepositoryConfig } from "../../core/config/schemas.js";
import type { PreflightRunGit } from "../runtime/preflight-runner.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import { repositoryRequiredMetadata } from "../../core/built-ins/metadata.js";
import { builtInError } from "../../core/built-ins/errors.js";
import {
  repositoryFrom,
  requiredState,
  workflowFrom
} from "../../core/built-ins/state.js";
import type {
  BuiltInStepDependencies,
  MaybePromise
} from "../../core/built-ins/types.js";

export type PreflightBuiltInDependencies = BuiltInStepDependencies & {
  runPreflight?: (input: {
    invocation: Invocation;
    repository: RepositoryConfig;
    workflow?: { mode: "read_only" | "trusted_local_write" };
  }) => MaybePromise<unknown>;
  runGit?: PreflightRunGit;
};

export const preflightBuiltIn = defineBuiltInStep<
  "runtime.preflight",
  PreflightBuiltInDependencies
>({
  name: "runtime.preflight",
  metadata: repositoryRequiredMetadata,
  async run({ state, dependencies = {} }) {
    const invocation = requiredState(
      state.invocation as Invocation | undefined,
      "invocation"
    );
    const input = {
      invocation,
      repository: repositoryFrom(state),
      workflow: workflowFrom(state)
    };

    if (dependencies.runPreflight !== undefined) {
      return await dependencies.runPreflight(input);
    }

    if (dependencies.runGit === undefined) {
      throw builtInError(
        "runtime.preflight requires a runGit dependency.",
        "built_in_dependency_missing"
      );
    }

    return await defaultRunPreflight({
      ...input,
      runGit: dependencies.runGit
    });
  }
});
