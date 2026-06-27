import type { ToolRegistration } from "../capabilities/manifest.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type {
  AgentRuntimeRequirement,
  ToolProtocol
} from "../agent-runtime/contracts.js";
import type { McpConfig } from "../config/mcp.js";
import type {
  AnyLunaToolDefinition,
  LunaToolMode
} from "./contracts.js";
import {
  resolveMcpPolicy,
  type ResolvedMcpPolicy,
  type ResolvedMcpPolicyTool
} from "./mcp-policy.js";

export type ResolvedTool = {
  readonly id: string;
  readonly protocol: ToolProtocol;
  readonly input_schema: unknown;
  readonly output_schema: unknown;
  readonly runtime_requirements: readonly AgentRuntimeRequirement[];
  readonly source: "local_contract" | "mcp_policy";
  readonly local?: AnyLunaToolDefinition;
  readonly mcp?: ResolvedMcpPolicyTool;
};

export type ResolvedToolCatalog = {
  readonly tools: readonly ResolvedTool[];
  readonly runtime_requirements: readonly AgentRuntimeRequirement[];
  readonly mcp_policy?: ResolvedMcpPolicy;
};

type ToolCatalogErrorCode =
  | "tool_catalog_tool_not_registered"
  | "tool_catalog_protocol_mismatch"
  | "tool_catalog_local_contract_missing"
  | "tool_catalog_local_mode_not_allowed"
  | "tool_catalog_runtime_requirement_unsupported";

class ToolCatalogError extends Error {
  readonly code: ToolCatalogErrorCode;

  constructor(code: ToolCatalogErrorCode, message: string) {
    super(message);
    this.name = "ToolCatalogError";
    this.code = code;
  }
}

function registeredTools(registry: CapabilityRegistry): Map<string, ToolRegistration> {
  const tools = new Map<string, ToolRegistration>();

  for (const manifest of registry.orderedManifests()) {
    for (const tool of Object.values(manifest.tools ?? {})) {
      tools.set(tool.id, tool);
    }
  }

  return tools;
}

function requireRegisteredTool(
  tools: ReadonlyMap<string, ToolRegistration>,
  id: string
): ToolRegistration {
  const tool = tools.get(id);

  if (tool === undefined) {
    throw new ToolCatalogError(
      "tool_catalog_tool_not_registered",
      `Tool is not capability-registered: ${id}`
    );
  }

  return tool;
}

function requireProtocol(tool: ToolRegistration, protocol: ToolProtocol): void {
  if (tool.protocol === protocol) {
    return;
  }

  throw new ToolCatalogError(
    "tool_catalog_protocol_mismatch",
    `Tool ${tool.id} is registered as ${tool.protocol}, not ${protocol}`
  );
}

function addRequirements(
  target: AgentRuntimeRequirement[],
  requirements: readonly string[] | undefined
): void {
  for (const requirement of requirements ?? []) {
    if (!isAgentRuntimeRequirement(requirement)) {
      throw new ToolCatalogError(
        "tool_catalog_runtime_requirement_unsupported",
        `Unsupported runtime requirement on tool registration: ${requirement}`
      );
    }

    if (!target.includes(requirement)) {
      target.push(requirement);
    }
  }
}

function isAgentRuntimeRequirement(
  value: string
): value is AgentRuntimeRequirement {
  return value === "tool_calling" || value === "mcp_tools";
}

function runtimeRequirementsFor(
  requirements: readonly string[] | undefined
): AgentRuntimeRequirement[] {
  const resolved: AgentRuntimeRequirement[] = [];
  addRequirements(resolved, requirements);

  return resolved;
}

function resolveLocalTool({
  id,
  registered,
  localTools,
  agentMode
}: {
  readonly id: string;
  readonly registered: ReadonlyMap<string, ToolRegistration>;
  readonly localTools: Readonly<Record<string, AnyLunaToolDefinition>>;
  readonly agentMode: LunaToolMode;
}): ResolvedTool {
  const registration = requireRegisteredTool(registered, id);
  requireProtocol(registration, "local");

  const local = localTools[id];
  if (local === undefined) {
    throw new ToolCatalogError(
      "tool_catalog_local_contract_missing",
      `Local tool ${id} is capability-registered but has no local contract`
    );
  }

  if (!local.modes.includes(agentMode)) {
    throw new ToolCatalogError(
      "tool_catalog_local_mode_not_allowed",
      `Local tool ${id} is not allowed for agent mode ${agentMode}`
    );
  }

  return {
    id,
    protocol: "local",
    input_schema: registration.input_schema,
    output_schema: registration.output_schema,
    runtime_requirements: runtimeRequirementsFor(registration.runtime_requirements),
    source: "local_contract",
    local
  };
}

function resolveMcpTool({
  policyTool,
  registered
}: {
  readonly policyTool: ResolvedMcpPolicyTool;
  readonly registered: ReadonlyMap<string, ToolRegistration>;
}): ResolvedTool | undefined {
  const registration = registered.get(policyTool.id);
  if (registration === undefined) {
    return undefined;
  }
  if (registration.protocol !== "mcp") {
    throw new ToolCatalogError(
      "tool_catalog_protocol_mismatch",
      `MCP policy allowed ${policyTool.id}, but it is registered as ${registration.protocol}`
    );
  }

  return {
    id: policyTool.id,
    protocol: "mcp",
    input_schema: registration.input_schema,
    output_schema: registration.output_schema,
    runtime_requirements: runtimeRequirementsFor(registration.runtime_requirements),
    source: "mcp_policy",
    mcp: policyTool
  };
}

export function resolveToolCatalog({
  registry,
  local_tools,
  requested_local_tool_ids,
  requested_mcp_server_ids,
  agent_mode,
  mcp_config
}: {
  readonly registry: CapabilityRegistry;
  readonly local_tools: Readonly<Record<string, AnyLunaToolDefinition>>;
  readonly requested_local_tool_ids: readonly string[];
  readonly requested_mcp_server_ids: readonly string[];
  readonly agent_mode: LunaToolMode;
  readonly mcp_config: McpConfig;
}): ResolvedToolCatalog {
  const registered = registeredTools(registry);
  const runtimeRequirements: AgentRuntimeRequirement[] = [];
  const resolvedTools: ResolvedTool[] = [];

  for (const id of requested_local_tool_ids) {
    const tool = resolveLocalTool({
      id,
      registered,
      localTools: local_tools,
      agentMode: agent_mode
    });
    resolvedTools.push(tool);
    addRequirements(runtimeRequirements, tool.runtime_requirements);
  }

  const mcpPolicy = resolveMcpPolicy({
    requested_server_ids: requested_mcp_server_ids,
    agent_mode,
    config: mcp_config
  });

  for (const policyTool of mcpPolicy.tools) {
    const tool = resolveMcpTool({ policyTool, registered });
    if (tool === undefined) {
      continue;
    }
    resolvedTools.push(tool);
    addRequirements(runtimeRequirements, tool.runtime_requirements);
  }

  addRequirements(runtimeRequirements, mcpPolicy.runtime_requirements);

  return {
    tools: resolvedTools,
    runtime_requirements: runtimeRequirements,
    ...(requested_mcp_server_ids.length === 0 ? {} : { mcp_policy: mcpPolicy })
  };
}
