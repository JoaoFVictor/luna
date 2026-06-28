import { runPreflight as defaultRunPreflight } from "../preflight/runner.js";
import type { Invocation } from "../router/invocation.js";
import type { RepositoryConfig } from "../config/schemas.js";
import type { ImplementationConfig } from "../write-mode/types.js";
import { defineBuiltInStep } from "./registry.js";
import { repositoryRequiredMetadata } from "./metadata.js";
import {
  implementationFrom,
  repositoryFrom,
  requiredState,
  workflowFrom
} from "./state.js";
import type {
  BuiltInStepDependencies,
  MaybePromise
} from "./types.js";

export type PreflightBuiltInDependencies = BuiltInStepDependencies & {
  runPreflight?: (input: {
    invocation: Invocation;
    repository: RepositoryConfig;
    workflow?: { mode: "read_only" | "trusted_local_write" };
    implementation?: ImplementationConfig["implementation"];
  }) => MaybePromise<unknown>;
};

export const preflightBuiltIn = defineBuiltInStep<
  "runtime.preflight",
  PreflightBuiltInDependencies
>({
  name: "runtime.preflight",
  metadata: repositoryRequiredMetadata,
  async run({ state, dependencies = {} }) {
    const runPreflight = dependencies.runPreflight ?? defaultRunPreflight;
    const invocation = requiredState(
      state.invocation as Invocation | undefined,
      "invocation"
    );

    return await runPreflight({
      invocation,
      repository: repositoryFrom(state),
      workflow: workflowFrom(state),
      implementation: implementationFrom(state)
    });
  }
});
