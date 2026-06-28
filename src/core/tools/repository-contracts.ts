import type { LocalToolContract, LunaToolMode } from "./contracts.js";
import {
  repositoryDeleteFileInputSchema,
  repositoryDeleteFileOutputSchema,
  repositoryEmptyInputSchema,
  repositoryReadFileInputSchema,
  repositoryReadFileOutputSchema,
  repositoryTextOutputSchema,
  repositoryWriteFileInputSchema,
  repositoryWriteFileOutputSchema
} from "./repository-schemas.js";

const allAgentModes = ["read_only", "trusted_local_write"] as const;
const toolCallingRequirement = ["tool_calling"] as const;

function repositoryToolContract(
  contract: Omit<LocalToolContract, "runtime_requirements">
): LocalToolContract {
  return {
    ...contract,
    runtime_requirements: toolCallingRequirement
  };
}

export const repositoryStatusToolContract = repositoryToolContract({
  id: "repository.status",
  description: "Return short git status for the bound repository worktree.",
  input_schema: repositoryEmptyInputSchema,
  output_schema: repositoryTextOutputSchema,
  safety: {
    localWrites: false,
    network: false,
    externalSideEffects: false
  },
  modes: allAgentModes
});

export const repositoryDiffSummaryToolContract = repositoryToolContract({
  id: "repository.diff-summary",
  description: "Return compact git diff stat for the bound repository worktree.",
  input_schema: repositoryEmptyInputSchema,
  output_schema: repositoryTextOutputSchema,
  safety: {
    localWrites: false,
    network: false,
    externalSideEffects: false
  },
  modes: allAgentModes
});

export const repositoryReadFileToolContract = repositoryToolContract({
  id: "repository.read-file",
  description: "Read a UTF-8 text file from the bound repository worktree.",
  input_schema: repositoryReadFileInputSchema,
  output_schema: repositoryReadFileOutputSchema,
  safety: {
    localWrites: false,
    network: false,
    externalSideEffects: false
  },
  modes: allAgentModes
});

export const repositoryWriteFileToolContract = repositoryToolContract({
  id: "repository.write-file",
  description: "Write a UTF-8 text file inside the bound repository worktree.",
  input_schema: repositoryWriteFileInputSchema,
  output_schema: repositoryWriteFileOutputSchema,
  safety: {
    localWrites: true,
    network: false,
    externalSideEffects: false
  },
  modes: ["trusted_local_write"] satisfies readonly LunaToolMode[]
});

export const repositoryDeleteFileToolContract = repositoryToolContract({
  id: "repository.delete-file",
  description: "Delete a file inside the bound repository worktree.",
  input_schema: repositoryDeleteFileInputSchema,
  output_schema: repositoryDeleteFileOutputSchema,
  safety: {
    localWrites: true,
    network: false,
    externalSideEffects: false
  },
  modes: ["trusted_local_write"] satisfies readonly LunaToolMode[]
});

export const repositoryLocalToolContracts = {
  [repositoryStatusToolContract.id]: repositoryStatusToolContract,
  [repositoryDiffSummaryToolContract.id]: repositoryDiffSummaryToolContract,
  [repositoryReadFileToolContract.id]: repositoryReadFileToolContract,
  [repositoryWriteFileToolContract.id]: repositoryWriteFileToolContract,
  [repositoryDeleteFileToolContract.id]: repositoryDeleteFileToolContract
} satisfies Record<string, LocalToolContract>;
