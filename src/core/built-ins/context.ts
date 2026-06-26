import { z } from "zod";
import { collectContextIntake } from "../../capabilities/context/collect-context.js";
import type { WorkspaceRecord } from "../write-mode/types.js";
import { defineBuiltInStep } from "./registry.js";
import { repositoryRequiredMetadata } from "./metadata.js";
import { repositoryFrom, requiredState } from "./state.js";

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

export const collectContextBuiltIn = defineBuiltInStep({
  name: "collect_context",
  metadata: repositoryRequiredMetadata,
  async run({ state, input }) {
    const parsed = CollectContextInputSchema.parse(input ?? {});
    const repository = repositoryFrom(state);

    return await collectContextIntake({
      repository,
      repositoryRoot: workspacePathFrom(state) ?? repository.path,
      agentsRoot: requiredState(state.agentsRoot, "agentsRoot"),
      agentIds: parsed.agents ?? [],
      maxFileBytes: parsed.max_file_bytes
    });
  }
});
