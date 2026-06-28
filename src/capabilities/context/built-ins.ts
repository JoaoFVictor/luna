import { z } from "zod";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import { repositoryRequiredMetadata } from "../../core/built-ins/metadata.js";
import { repositoryFrom, requiredState } from "../../core/built-ins/state.js";
import { builtInError } from "../../core/built-ins/errors.js";
import type {
  CollectContextIntakeInput,
  ContextIntake
} from "../../core/context/collect-context-contracts.js";
import type { BuiltInStepDependencies, MaybePromise } from "../../core/built-ins/types.js";

type ContextBuiltInDependencies = BuiltInStepDependencies & {
  collectContextIntake?: (
    input: CollectContextIntakeInput
  ) => MaybePromise<ContextIntake>;
};

type WorkspacePathState = {
  readonly workspace?: {
    readonly path?: unknown;
  };
};

const CollectContextInputSchema = z
  .object({
    agents: z.array(z.string().min(1)).optional(),
    max_file_bytes: z.number().int().positive().optional()
  })
  .strict();

function workspacePathFrom(state: { readonly workspace?: unknown }): string | undefined {
  const workspace = state.workspace as WorkspacePathState["workspace"];
  return typeof workspace?.path === "string" ? workspace.path : undefined;
}

export const collectContextBuiltIn = defineBuiltInStep<
  "context.collect_context",
  ContextBuiltInDependencies
>({
  name: "context.collect_context",
  metadata: repositoryRequiredMetadata,
  async run({ state, input, dependencies = {} }) {
    if (dependencies.collectContextIntake === undefined) {
      throw builtInError(
        "collect_context requires a collectContextIntake dependency.",
        "built_in_dependency_missing"
      );
    }

    const parsed = CollectContextInputSchema.parse(input ?? {});
    const repository = repositoryFrom(state);

    return await dependencies.collectContextIntake({
      repository,
      repositoryRoot: workspacePathFrom(state) ?? repository.path,
      agentsRoot: requiredState(state.agentsRoot, "agentsRoot"),
      agentIds: parsed.agents ?? [],
      maxFileBytes: parsed.max_file_bytes
    });
  }
});
