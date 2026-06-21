import * as v from "valibot";
import { runGit } from "../git/client.js";
import type {
  LunaToolDefinition,
  LunaToolDependencies
} from "./contracts.js";

const emptyParameters = v.object({});
type EmptyInput = v.InferOutput<typeof emptyParameters>;
type RepositoryToolDefinition = LunaToolDefinition<EmptyInput, string>;
const allAgentModes = ["read_only", "trusted_host_local_write"] as const;

function repositoryHandler(
  dependencies: LunaToolDependencies,
  args: readonly string[]
): () => Promise<string> {
  return async () => await runGit(dependencies.cwd, args);
}

export const repositoryStatusTool: RepositoryToolDefinition = {
  id: "repository.status",
  description: "Return short git status for the bound repository worktree.",
  parameters: emptyParameters,
  safety: {
    localWrites: false,
    network: false,
    externalSideEffects: false
  },
  modes: allAgentModes,
  createHandler: (dependencies) =>
    repositoryHandler(dependencies, ["status", "--short"])
};

export const repositoryDiffSummaryTool: RepositoryToolDefinition = {
  id: "repository.diff-summary",
  description: "Return compact git diff stat for the bound repository worktree.",
  parameters: emptyParameters,
  safety: {
    localWrites: false,
    network: false,
    externalSideEffects: false
  },
  modes: allAgentModes,
  createHandler: (dependencies) =>
    repositoryHandler(dependencies, ["diff", "--stat"])
};
