import {
  AgentRuntimeError,
  type AgentRuntimeDescriptor,
  type AgentRuntimeRequirement,
  type RunAgentInput,
  type ToolProtocol
} from "./contracts.js";

function hasRequirement(
  requirements: readonly AgentRuntimeRequirement[],
  requirement: AgentRuntimeRequirement
): boolean {
  return requirements.includes(requirement);
}

function requireDeclaredRuntimeRequirement(
  input: RunAgentInput,
  requirement: AgentRuntimeRequirement
): void {
  if (hasRequirement(input.runtime_requirements, requirement)) {
    return;
  }

  throw new AgentRuntimeError(
    "runtime_unsupported_feature",
    `Agent runtime requirement is missing: ${requirement}`,
    { details: { missing_requirement: requirement } }
  );
}

function requireSupportedRuntimeRequirement(
  descriptor: AgentRuntimeDescriptor,
  requirement: AgentRuntimeRequirement
): void {
  if (hasRequirement(descriptor.supported_runtime_requirements, requirement)) {
    return;
  }

  throw new AgentRuntimeError(
    "runtime_unsupported_feature",
    `Runtime ${descriptor.id} does not support requirement: ${requirement}`,
    { details: { unsupported_requirement: requirement } }
  );
}

function requireSupportedToolProtocol(
  descriptor: AgentRuntimeDescriptor,
  tool: { readonly id: string; readonly protocol: ToolProtocol }
): void {
  if (descriptor.supported_tool_protocols.includes(tool.protocol)) {
    return;
  }

  throw new AgentRuntimeError(
    "runtime_unsupported_feature",
    `Runtime ${descriptor.id} does not support ${tool.protocol} tools`,
    { details: { tool_id: tool.id, protocol: tool.protocol } }
  );
}

export async function validateAgentRuntimeInput(
  input: RunAgentInput,
  descriptor: AgentRuntimeDescriptor
): Promise<void> {
  for (const requirement of input.runtime_requirements) {
    requireSupportedRuntimeRequirement(descriptor, requirement);
  }

  const hasTools = input.tools.tools.length > 0;
  const hasMcpTools = input.tools.tools.some((tool) => tool.protocol === "mcp");

  for (const tool of input.tools.tools) {
    requireSupportedToolProtocol(descriptor, tool);
  }

  if (hasTools) {
    requireDeclaredRuntimeRequirement(input, "tool_calling");
    requireSupportedRuntimeRequirement(descriptor, "tool_calling");
  }

  if (hasMcpTools) {
    requireDeclaredRuntimeRequirement(input, "mcp_tools");
    requireSupportedRuntimeRequirement(descriptor, "mcp_tools");
  }
}
