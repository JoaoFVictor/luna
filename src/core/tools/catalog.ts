import type { AnyLunaToolDefinition } from "./contracts.js";
import {
  repositoryDeleteFileTool,
  repositoryDiffSummaryTool,
  repositoryReadFileTool,
  repositoryStatusTool,
  repositoryWriteFileTool
} from "./repository.js";

export const lunaToolCatalog = {
  [repositoryStatusTool.id]: repositoryStatusTool,
  [repositoryDiffSummaryTool.id]: repositoryDiffSummaryTool,
  [repositoryReadFileTool.id]: repositoryReadFileTool,
  [repositoryWriteFileTool.id]: repositoryWriteFileTool,
  [repositoryDeleteFileTool.id]: repositoryDeleteFileTool
} satisfies Record<string, AnyLunaToolDefinition>;
