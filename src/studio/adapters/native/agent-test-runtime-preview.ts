import path from "node:path";
import type { LoadedAgentDefinition } from "../../../capabilities/agents/agent-definition.js";
import { loadAgentDefinition } from "../../../capabilities/agents/agent-loader.js";
import { lunaToolCatalog } from "../../../capabilities/repository/tool-catalog.js";
import type {
  AgentRuntimeDescriptor,
  AgentRuntimePort,
  ToolProtocol
} from "../../../core/agent-runtime/contracts.js";
import { loadYamlFile } from "../../../core/config/loader.js";
import { loadMcpConfig, type McpConfig } from "../../../core/config/mcp.js";
import { resolveModelProfiles } from "../../../core/config/models.js";
import {
  AppConfigSchema,
  ModelsConfigSchema,
  type AppConfig,
  type ModelProfile
} from "../../../core/config/schemas.js";
import type { JsonObject } from "../../../core/runtime/backends/contracts.js";
import type { ResolvedToolCatalog } from "../../../core/tools/resolved-catalog.js";
import { resolveToolCatalog } from "../../../core/tools/resolved-catalog.js";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import type { NativeLunaPlatformRegistrations } from "../../../platform/native/native-platform-registrations.js";
import type { AgentRuntimeFactory } from "../../../runtime/composition/runtime-composition.js";
import { studioAgentTestError } from "../../application/agents/test-bench-errors.js";
import type {
  StudioAgentTestBlocker,
  StudioAgentTestMcpPreview,
  StudioAgentTestModelProfile,
  StudioAgentTestRequirementPreview,
  StudioAgentTestResolution,
  StudioAgentTestSubagentPreview,
  StudioAgentTestToolPreview
} from "../../contracts/agent-test-bench.js";

export type NativeStudioAgentTestPlatform = Pick<
  NativeLunaPlatformRegistrations,
  | "agentRuntimeFactories"
  | "capabilityRegistry"
  | "workflowBuiltIns"
  | "taskProviderBuiltIns"
>;

type EffectiveResolution = Omit<
  StudioAgentTestResolution,
  | "target"
  | "catalog_fingerprint"
  | "output_schema_hash"
  | "instructions_hash"
  | "scope"
>;

export type NativeStudioAgentTestEffectivePreview = {
  readonly resolution: EffectiveResolution;
  readonly selectedModelProfile: ModelProfile;
  readonly runtime?: AgentRuntimePort;
  readonly runtimeFactory?: AgentRuntimeFactory;
  readonly runtimeOptions: JsonObject;
};

type ResolvedRuntime = {
  readonly runtime?: AgentRuntimePort;
  readonly factory?: AgentRuntimeFactory;
  readonly options: JsonObject;
  readonly descriptor: AgentRuntimeDescriptor;
  readonly preview: StudioAgentTestResolution["runtime"];
  readonly blocker?: StudioAgentTestBlocker;
};

async function loadApp(configRoot: string): Promise<AppConfig> {
  try {
    return await loadYamlFile(path.join(configRoot, "app.yaml"), AppConfigSchema);
  } catch (cause) {
    throw studioAgentTestError(
      "studio_agent_test_runtime_unavailable",
      "The configured agent runtime cannot be loaded",
      {},
      { cause }
    );
  }
}

async function loadModels(configRoot: string) {
  try {
    return resolveModelProfiles(await loadYamlFile(
      path.join(configRoot, "models.yaml"),
      ModelsConfigSchema
    ));
  } catch (cause) {
    throw studioAgentTestError(
      "studio_agent_test_model_profile_unavailable",
      "The configured model profiles cannot be loaded",
      {},
      { cause }
    );
  }
}

async function loadMcpForAgent(
  definition: LoadedAgentDefinition,
  configRoot: string
): Promise<McpConfig> {
  if ((definition.mcp_servers ?? []).length === 0) {
    return { mcp_servers: [] };
  }
  try {
    return await loadMcpConfig(configRoot);
  } catch (cause) {
    throw studioAgentTestError(
      "studio_agent_test_target_invalid",
      "The agent's declared MCP configuration cannot be resolved",
      { agent_id: definition.id },
      { cause }
    );
  }
}

function modelPreview(
  id: string,
  profile: ModelProfile
): StudioAgentTestModelProfile {
  return {
    id,
    ...(profile.provider === undefined ? {} : { provider: profile.provider }),
    model: profile.model,
    reasoning_effort: profile.reasoning_effort,
    ...(profile.transport === undefined ? {} : { transport: profile.transport })
  };
}

function runtimeDescriptorIsValid(
  descriptor: AgentRuntimeDescriptor,
  expectedId: string
): boolean {
  return (
    descriptor.id === expectedId &&
    descriptor.id.trim() !== "" &&
    descriptor.display_name.trim() !== "" &&
    Array.isArray(descriptor.supported_tool_protocols) &&
    descriptor.supported_tool_protocols.every(
      (protocol) => protocol === "local" || protocol === "mcp"
    ) &&
    Array.isArray(descriptor.supported_runtime_requirements) &&
    descriptor.supported_runtime_requirements.every(
      (requirement) =>
        typeof requirement === "string" && requirement.trim() !== ""
    )
  );
}

function unavailableRuntimeDescriptor(id: string): AgentRuntimeDescriptor {
  return {
    id,
    display_name: id,
    supported_tool_protocols: [],
    supported_runtime_requirements: []
  };
}

function resolveRuntime(
  app: AppConfig,
  factories: NativeStudioAgentTestPlatform["agentRuntimeFactories"]
): ResolvedRuntime {
  const selection = app.agent_runtime ?? { id: "pi", options: {} };
  const options = selection.options as JsonObject;
  const factory = factories[selection.id];
  let runtime: AgentRuntimePort | undefined;
  let descriptor = unavailableRuntimeDescriptor(selection.id);
  let blocker: StudioAgentTestBlocker | undefined;
  try {
    if (factory === undefined || factory.id !== selection.id) {
      throw new Error("Configured agent runtime factory is unavailable");
    }
    runtime = factory.create(options);
    descriptor = runtime.describe();
    if (!runtimeDescriptorIsValid(descriptor, selection.id)) {
      throw new Error("Configured agent runtime descriptor is invalid");
    }
  } catch {
    runtime = undefined;
    descriptor = unavailableRuntimeDescriptor(selection.id);
    blocker = {
      code: "runtime_validation_failed",
      message:
        "The configured agent runtime could not be initialized safely for this smoke test."
    };
  }
  const normalizedDescriptor: AgentRuntimeDescriptor = {
    id: descriptor.id,
    display_name: descriptor.display_name,
    supported_tool_protocols: [
      ...new Set(descriptor.supported_tool_protocols)
    ].sort() as ToolProtocol[],
    supported_runtime_requirements: [
      ...new Set(descriptor.supported_runtime_requirements)
    ].sort()
  };
  return {
    ...(runtime === undefined ? {} : { runtime }),
    ...(factory === undefined ? {} : { factory }),
    options,
    descriptor: normalizedDescriptor,
    preview: {
      id: normalizedDescriptor.id,
      display_name: normalizedDescriptor.display_name,
      supported_tool_protocols: [
        ...normalizedDescriptor.supported_tool_protocols
      ],
      supported_runtime_requirements: [
        ...normalizedDescriptor.supported_runtime_requirements
      ],
      configuration_hash: sha256Digest({
        selection,
        descriptor: normalizedDescriptor
      })
    },
    ...(blocker === undefined ? {} : { blocker })
  };
}

function supportsTool(
  descriptor: AgentRuntimeDescriptor,
  tool: ResolvedToolCatalog["tools"][number]
): boolean {
  return (
    descriptor.supported_tool_protocols.includes(tool.protocol) &&
    tool.runtime_requirements.every((requirement) =>
      descriptor.supported_runtime_requirements.includes(requirement)
    )
  );
}

function toolPreviews(
  catalog: ResolvedToolCatalog,
  descriptor: AgentRuntimeDescriptor
): StudioAgentTestToolPreview[] {
  return catalog.tools.map((tool) => {
    const runtimeSupported = supportsTool(descriptor, tool);
    return {
      id: tool.id,
      protocol: tool.protocol,
      execution: runtimeSupported
        ? "excluded_no_isolation"
        : "excluded_runtime_unsupported",
      reason: runtimeSupported
        ? "Excluded because Studio has no proven isolated filesystem or side-effect boundary for agent smoke tests."
        : `Excluded because runtime ${descriptor.id} cannot materialize this capability safely.`,
      runtime_requirements: [...tool.runtime_requirements],
      ...(tool.local === undefined
        ? {}
        : {
            safety: {
              local_writes: tool.local.safety.localWrites,
              network: tool.local.safety.network,
              external_side_effects: tool.local.safety.externalSideEffects
            }
          })
    };
  });
}

function mcpPreviews(
  catalog: ResolvedToolCatalog,
  descriptor: AgentRuntimeDescriptor
): StudioAgentTestMcpPreview[] {
  return (catalog.mcp_policy?.servers ?? []).map((server) => {
    const runtimeSupported =
      descriptor.supported_tool_protocols.includes("mcp") &&
      catalog.mcp_policy?.runtime_requirements.every((requirement) =>
        descriptor.supported_runtime_requirements.includes(requirement)
      ) === true;
    return {
      id: server.id,
      configured: true,
      runtime_supported: runtimeSupported,
      execution: "excluded_from_smoke",
      reason: runtimeSupported
        ? "Configured, but MCP is excluded from the isolated smoke scope."
        : `Configured, but runtime ${descriptor.id} does not materialize the required MCP protocol and requirements.`
    };
  });
}

async function subagentPreviews(
  definition: LoadedAgentDefinition,
  agentsRoot: string,
  capabilityRegistry: NativeStudioAgentTestPlatform["capabilityRegistry"]
): Promise<StudioAgentTestSubagentPreview[]> {
  try {
    return await Promise.all((definition.subagents ?? []).map(async (reference) => {
      const subagent = await loadAgentDefinition(agentsRoot, reference.id, {
        capabilityRegistry
      });
      return {
        id: reference.id,
        declared_mode: subagent.mode,
        ...(!("policy" in reference) || reference.policy?.mode === undefined
          ? {}
          : { policy_mode: reference.policy.mode }),
        execution: "excluded_from_smoke" as const,
        reason:
          "Subagent invocation is excluded; this smoke test calls only the selected agent."
      };
    }));
  } catch (cause) {
    throw studioAgentTestError(
      "studio_agent_test_target_invalid",
      "The agent's declared subagents cannot be resolved",
      { agent_id: definition.id },
      { cause }
    );
  }
}

function requirementPreviews(
  definition: LoadedAgentDefinition,
  catalog: ResolvedToolCatalog,
  descriptor: AgentRuntimeDescriptor
): StudioAgentTestRequirementPreview[] {
  type Source = "agent" | "local_tool" | "mcp";
  const requirements = new Map<
    string,
    { sources: Set<Source>; required: boolean }
  >();
  const add = (id: string, source: Source, required: boolean) => {
    const current = requirements.get(id) ?? {
      sources: new Set<Source>(),
      required: false
    };
    current.sources.add(source);
    current.required ||= required;
    requirements.set(id, current);
  };
  for (const id of definition.runtime_requirements ?? []) {
    add(id, "agent", true);
  }
  for (const tool of catalog.tools) {
    for (const id of tool.runtime_requirements) {
      add(id, tool.protocol === "local" ? "local_tool" : "mcp", false);
    }
  }
  for (const id of catalog.mcp_policy?.runtime_requirements ?? []) {
    add(id, "mcp", false);
  }
  const sourceOrder: readonly Source[] = ["agent", "local_tool", "mcp"];
  return [...requirements.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, value]) => ({
      id,
      sources: sourceOrder.filter((source) => value.sources.has(source)),
      runtime_supported:
        descriptor.supported_runtime_requirements.includes(id),
      required_for_smoke: value.required
    }));
}

function executionBlockers(
  definition: LoadedAgentDefinition,
  requirements: readonly StudioAgentTestRequirementPreview[],
  runtimeBlocker: StudioAgentTestBlocker | undefined
): StudioAgentTestBlocker[] {
  const blockers: StudioAgentTestBlocker[] = [];
  if (definition.mode === "trusted_local_write") {
    blockers.push({
      code: "trusted_write_requires_isolation",
      message:
        "Trusted local write agents cannot run until Studio proves an isolated filesystem and side-effect boundary."
    });
  }
  for (const requirement of requirements) {
    if (requirement.required_for_smoke && !requirement.runtime_supported) {
      blockers.push({
        code: "runtime_requirement_unsupported",
        message: `Runtime requirement ${requirement.id} is declared by the agent but unsupported by the configured runtime.`
      });
    }
  }
  if (runtimeBlocker !== undefined) {
    blockers.push(runtimeBlocker);
  }
  return blockers;
}

function resolveCatalog(
  definition: LoadedAgentDefinition,
  mcpConfig: McpConfig,
  platform: NativeStudioAgentTestPlatform
): ResolvedToolCatalog {
  try {
    return resolveToolCatalog({
      registry: platform.capabilityRegistry,
      local_tools: lunaToolCatalog,
      requested_local_tool_ids: definition.tools ?? [],
      requested_mcp_server_ids: definition.mcp_servers ?? [],
      agent_mode: definition.mode,
      mcp_config: mcpConfig
    });
  } catch (cause) {
    throw studioAgentTestError(
      "studio_agent_test_target_invalid",
      "The agent's declared tools or MCP servers cannot be resolved",
      { agent_id: definition.id },
      { cause }
    );
  }
}

export async function resolveNativeStudioAgentTestEffectivePreview(options: {
  readonly definition: LoadedAgentDefinition;
  readonly selectedModelProfileId?: string;
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly platform: NativeStudioAgentTestPlatform;
}): Promise<NativeStudioAgentTestEffectivePreview> {
  const [app, profiles, mcpConfig, subagents] = await Promise.all([
    loadApp(options.configRoot),
    loadModels(options.configRoot),
    loadMcpForAgent(options.definition, options.configRoot),
    subagentPreviews(
      options.definition,
      path.join(options.projectRoot, "agents"),
      options.platform.capabilityRegistry
    )
  ]);
  const profileEntries = Object.entries(profiles)
    .sort(([left], [right]) => left.localeCompare(right));
  if (profiles[options.definition.model_profile] === undefined) {
    throw studioAgentTestError(
      "studio_agent_test_model_profile_unavailable",
      "The agent's default model profile is not loaded",
      {
        agent_id: options.definition.id,
        model_profile_id: options.definition.model_profile
      }
    );
  }
  const selectedProfileId =
    options.selectedModelProfileId ?? options.definition.model_profile;
  const selectedModelProfile = profiles[selectedProfileId];
  if (selectedModelProfile === undefined) {
    throw studioAgentTestError(
      "studio_agent_test_model_profile_unavailable",
      "The selected model profile is not loaded",
      { model_profile_id: selectedProfileId }
    );
  }
  const runtime = resolveRuntime(
    app,
    options.platform.agentRuntimeFactories
  );
  const catalog = resolveCatalog(
    options.definition,
    mcpConfig,
    options.platform
  );
  const requirements = requirementPreviews(
    options.definition,
    catalog,
    runtime.descriptor
  );
  return {
    resolution: {
      agent_mode: options.definition.mode,
      default_model_profile_id: options.definition.model_profile,
      selected_model_profile: modelPreview(
        selectedProfileId,
        selectedModelProfile
      ),
      available_model_profiles: profileEntries.map(([id, profile]) =>
        modelPreview(id, profile)
      ),
      runtime: runtime.preview,
      tools: toolPreviews(catalog, runtime.descriptor),
      mcp_servers: mcpPreviews(catalog, runtime.descriptor),
      subagents,
      declared_skills: [...(options.definition.skills ?? [])],
      declared_agent_context_files: [
        ...(options.definition.context?.files ?? [])
      ],
      runtime_requirements: requirements,
      blockers: executionBlockers(
        options.definition,
        requirements,
        runtime.blocker
      )
    },
    selectedModelProfile,
    ...(runtime.runtime === undefined ? {} : { runtime: runtime.runtime }),
    ...(runtime.factory === undefined
      ? {}
      : { runtimeFactory: runtime.factory }),
    runtimeOptions: runtime.options
  };
}
