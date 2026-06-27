import { z } from "zod";
import type { WorkspaceRecord } from "../write-mode/types.js";
import { defineBuiltInStep } from "./registry.js";
import { repositoryRequiredMetadata } from "./metadata.js";
import { repositoryFrom, requiredState } from "./state.js";
import { builtInError } from "./errors.js";
import type {
  CollectContextIntakeInput,
  ContextIntake
} from "../context/collect-context-contracts.js";
import type { BuiltInStepDependencies, MaybePromise } from "./types.js";

type ContextBuiltInDependencies = BuiltInStepDependencies & {
  collectContextIntake?: (
    input: CollectContextIntakeInput
  ) => MaybePromise<ContextIntake>;
};

const CollectContextInputSchema = z
  .object({
    agents: z.array(z.string().min(1)).optional(),
    max_file_bytes: z.number().int().positive().optional()
  })
  .strict();

function workspacePathFrom(state: {
  readonly workspace?: unknown;
}): string | undefined {
  const workspace = state.workspace as Partial<WorkspaceRecord> | undefined;
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
