import type { ToolDefinition } from "@flue/runtime";
import {
  repositoryDiffSummaryTool,
  repositoryStatusTool
} from "../tools/repository-tools.js";
import type { AgentDefinition } from "./agent-definition.js";

type ToolFactory = (cwd: string) => ToolDefinition;
type AgentMode = AgentDefinition["mode"];

type RegisteredTool = {
  factory: ToolFactory;
  allowedAgentModes: readonly AgentMode[];
};

const allAgentModes: readonly AgentMode[] = [
  "read_only",
  "trusted_host_local_write"
];

const toolRegistry: Record<string, RegisteredTool> = {
  "repository.status": {
    factory: repositoryStatusTool,
    allowedAgentModes: allAgentModes
  },
  "repository.diff-summary": {
    factory: repositoryDiffSummaryTool,
    allowedAgentModes: allAgentModes
  }
};

function toolError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export function resolveFlueTools({
  ids,
  agentMode,
  cwd
}: {
  ids: readonly string[];
  agentMode: AgentMode;
  cwd: string;
}): ToolDefinition[] {
  return ids.map((id) => {
    const tool = toolRegistry[id];

    if (tool === undefined) {
      throw toolError(`Unknown Flue tool: ${id}`, "flue_tool_unknown");
    }

    if (!tool.allowedAgentModes.includes(agentMode)) {
      throw toolError(
        `Flue tool ${id} is not allowed for agent mode ${agentMode}`,
        "flue_tool_mode_not_allowed"
      );
    }

    return tool.factory(cwd);
  });
}
