import { defineTool, type ToolDefinition } from "@flue/runtime";
import { lunaToolCatalog } from "../../tools/catalog.js";
import type {
  AnyLunaToolDefinition,
  LunaToolSafety
} from "../../tools/contracts.js";
import type { AgentDefinition } from "../../../capabilities/agents/agent-definition.js";

type AgentMode = AgentDefinition["mode"];

function toolError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function flueToolName(id: string): string {
  return id.replaceAll(".", "_").replaceAll("-", "_");
}

function assertFlueParameters(parameters: unknown): asserts parameters is object {
  if (typeof parameters !== "object" || parameters === null) {
    throw toolError(
      "Flue tool parameters must be an object schema",
      "flue_tool_parameters_invalid"
    );
  }
}

export function assertToolSafety(safety: LunaToolSafety): void {
  if (typeof safety.localWrites !== "boolean") {
    throw toolError(
      "tools must declare whether they perform local writes",
      "flue_tool_safety_invalid"
    );
  }
  if (typeof safety.network !== "boolean") {
    throw toolError(
      "tools must declare whether they use network access",
      "flue_tool_safety_invalid"
    );
  }
  if (typeof safety.externalSideEffects !== "boolean") {
    throw toolError(
      "tools must declare whether they perform external side effects",
      "flue_tool_safety_invalid"
    );
  }
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  return JSON.stringify(output) ?? String(output);
}

function createFlueExecute({
  tool,
  cwd
}: {
  tool: AnyLunaToolDefinition;
  cwd: string;
}): ToolDefinition["execute"] {
  const execute = tool.createHandler({ cwd });

  return async (input) => stringifyToolOutput(await execute(input));
}

export function registeredFlueToolSafety(): Record<string, LunaToolSafety> {
  return Object.fromEntries(
    Object.entries(lunaToolCatalog).map(([id, tool]) => [id, tool.safety])
  );
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
    const tool = lunaToolCatalog[id];

    if (tool === undefined) {
      throw toolError(`Unknown Flue tool: ${id}`, "flue_tool_unknown");
    }

    if (!tool.modes.includes(agentMode)) {
      throw toolError(
        `Flue tool ${id} is not allowed for agent mode ${agentMode}`,
        "flue_tool_mode_not_allowed"
      );
    }

    assertToolSafety(tool.safety);
    assertFlueParameters(tool.parameters);

    return defineTool({
      name: flueToolName(tool.id),
      description: tool.description,
      parameters: tool.parameters,
      execute: createFlueExecute({ tool, cwd })
    });
  });
}
