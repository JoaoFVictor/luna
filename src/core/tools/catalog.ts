import type { LunaToolDefinition } from "./contracts.js";
import {
  repositoryDiffSummaryTool,
  repositoryStatusTool
} from "./repository.js";

export const lunaToolCatalog = {
  [repositoryStatusTool.id]: repositoryStatusTool,
  [repositoryDiffSummaryTool.id]: repositoryDiffSummaryTool
} satisfies Record<string, LunaToolDefinition<Record<string, never>, string>>;
