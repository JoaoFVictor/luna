import type { ToolDefinition } from "@flue/runtime";
import {
  repositoryDiffSummaryTool,
  repositoryStatusTool
} from "../tools/repository-tools.js";

type ToolFactory = (cwd: string) => ToolDefinition;

const toolRegistry: Record<string, ToolFactory> = {
  "repository.status": repositoryStatusTool,
  "repository.diff-summary": repositoryDiffSummaryTool
};

function toolError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export function resolveFlueTools({
  ids,
  cwd
}: {
  ids: readonly string[];
  cwd: string;
}): ToolDefinition[] {
  return ids.map((id) => {
    const factory = toolRegistry[id];

    if (factory === undefined) {
      throw toolError(`Unknown Flue tool: ${id}`, "flue_tool_unknown");
    }

    return factory(cwd);
  });
}
