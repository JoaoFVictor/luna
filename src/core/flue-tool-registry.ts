import type { ToolDefinition } from "@flue/runtime";
import {
  repositoryDiffSummaryTool,
  repositoryStatusTool
} from "../tools/repository-tools.js";
import type { AgentDefinition } from "./agent-definition.js";

type ToolFactory = (cwd: string) => ToolDefinition;
type AgentMode = AgentDefinition["mode"];

export type ToolSafety = {
  writes: boolean;
  network: boolean;
  side_effects: boolean;
  subagent_read_only_allowed: boolean;
};

type RegisteredTool = {
  factory: ToolFactory;
  allowedAgentModes: readonly AgentMode[];
  safety: ToolSafety;
};

const allAgentModes: readonly AgentMode[] = [
  "read_only",
  "trusted_host_local_write"
];

function toolError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export function assertToolSafety(safety: ToolSafety): void {
  if (
    safety.subagent_read_only_allowed &&
    (safety.writes || safety.network || safety.side_effects)
  ) {
    throw toolError(
      "subagent_read_only_allowed requires a read-only, no-network, no-side-effect tool",
      "flue_tool_safety_invalid"
    );
  }
}

function defineRegisteredTool(tool: RegisteredTool): RegisteredTool {
  assertToolSafety(tool.safety);

  return tool;
}

const toolRegistry: Record<string, RegisteredTool> = {
  "repository.status": defineRegisteredTool({
    factory: repositoryStatusTool,
    allowedAgentModes: allAgentModes,
    safety: {
      writes: false,
      network: false,
      side_effects: false,
      subagent_read_only_allowed: true
    }
  }),
  "repository.diff-summary": defineRegisteredTool({
    factory: repositoryDiffSummaryTool,
    allowedAgentModes: allAgentModes,
    safety: {
      writes: false,
      network: false,
      side_effects: false,
      subagent_read_only_allowed: true
    }
  })
};

export function registeredFlueToolSafety(): Record<string, ToolSafety> {
  return Object.fromEntries(
    Object.entries(toolRegistry).map(([id, tool]) => [id, tool.safety])
  );
}

export function resolveFlueTools({
  ids,
  agentMode,
  cwd,
  forSubagent = false
}: {
  ids: readonly string[];
  agentMode: AgentMode;
  cwd: string;
  forSubagent?: boolean;
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

    if (forSubagent) {
      const isSubagentSafe =
        agentMode === "read_only" &&
        !tool.safety.writes &&
        !tool.safety.network &&
        !tool.safety.side_effects &&
        tool.safety.subagent_read_only_allowed;

      if (!isSubagentSafe) {
        throw toolError(
          `Flue tool ${id} is not allowed for read-only subagents`,
          "flue_tool_subagent_not_allowed"
        );
      }
    }

    return tool.factory(cwd);
  });
}
