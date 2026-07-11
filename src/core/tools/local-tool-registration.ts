import type { ToolRegistration } from "../capabilities/manifest.js";
import type { LocalToolContract } from "./contracts.js";

export function localToolRegistrations(
  tools: Readonly<Record<string, LocalToolContract>>
): Record<string, ToolRegistration> {
  return Object.fromEntries(
    Object.values(tools).map((tool) => [
      tool.id,
      {
        id: tool.id,
        protocol: "local",
        input_schema: tool.input_schema,
        output_schema: tool.output_schema,
        runtime_requirements: tool.runtime_requirements,
        materialization: "local",
        allowed_agent_modes: tool.modes,
        safety: tool.safety
      } satisfies ToolRegistration
    ])
  );
}
