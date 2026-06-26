import { loadAgentDefinition } from "../../capabilities/agents/agent-loader.js";
import type {
  AgentDefinition,
  LoadedAgentDefinition
} from "../../capabilities/agents/agent-definition.js";
import { runAgentNode } from "../../capabilities/agents/agent-node.js";
import {
  runBuiltInStep as defaultRunBuiltInStep
} from "../built-ins/executor.js";
import type {
  BuiltInStepDependencies,
  RunBuiltInStepOptions
} from "../built-ins/types.js";
import { resolveWorkflowInput, type WorkflowState } from "../workflow/state.js";
import type { WorkflowSubagentPolicy } from "../agents/subagent-policy.js";
import type { ResolvedModelProfiles } from "../config/models.js";
import type { ArtifactStore } from "../artifacts/store.js";
import type {
  ValidationCommand
} from "../validation/runner.js";
import type { ModelProfile } from "../config/schemas.js";
import type {
  AgentRuntimePort,
  AgentRuntimeRequirement
} from "../agent-runtime/contracts.js";
import type { RunHandle } from "../runtime/run-handle.js";
import type { ResolvedSkillReference } from "../skills/definition.js";
import type { ResolvedToolCatalog } from "../tools/resolved-catalog.js";
import { ValidationCommandSchema } from "../validation/runner.js";
import type {
  LunaObservability
} from "../observability/luna-observability.js";
import type { ObservabilitySummary } from "../observability/summary.js";
import { configuredWorkflowError } from "./errors.js";
import type { ConfiguredWorkflowNodeRunner } from "./contracts.js";
import type {
  ConfiguredWorkflowRuntimeNode
} from "./runtime-node.js";

type MaybePromise<T> = T | Promise<T>;

type GatedAgentLoopWorkflowNode = Extract<
  ConfiguredWorkflowRuntimeNode,
  { type: "gated_agent_loop" }
>;

type ResolvedValidationGate = Extract<
  GatedAgentLoopWorkflowNode["gates"][number],
  { type: "validation_commands" }
> & {
  commands: ValidationCommand[];
  max_output_bytes: number;
};

type ResolvedAgentGate = Extract<
  GatedAgentLoopWorkflowNode["gates"][number],
  { type: "agent" }
> & {
  input?: Record<string, unknown>;
};

type ResolvedGatedAgentLoopNode = Omit<
  GatedAgentLoopWorkflowNode,
  "sandbox" | "gates" | "repair"
> & {
  sandbox: {
    type: "trusted_host_local";
    cwd: string;
    env_allowlist: string[];
  };
  gates: Array<ResolvedValidationGate | ResolvedAgentGate>;
  repair: {
    attempts: number;
  };
};

export type RunGatedAgentLoopStepOptions = {
  agent: AgentDefinition;
  gateAgents: Record<string, AgentDefinition>;
  node: ResolvedGatedAgentLoopNode;
  model: ModelProfile;
  agentsRoot: string;
  modelProfiles: ResolvedModelProfiles;
  workflowSubagentPolicy: WorkflowSubagentPolicy;
  input: Record<string, unknown>;
  sandbox: ResolvedGatedAgentLoopNode["sandbox"];
  gates: ResolvedGatedAgentLoopNode["gates"];
  repair: ResolvedGatedAgentLoopNode["repair"];
  state: WorkflowState;
  observability?: LunaObservability;
  summary?: ObservabilitySummary;
  artifactStore?: ArtifactStore;
};

export type ResolveAgentToolCatalogOptions = {
  readonly agent: LoadedAgentDefinition;
  readonly node: Extract<ConfiguredWorkflowRuntimeNode, { type: "agent" }>;
  readonly input: Record<string, unknown>;
  readonly state: WorkflowState;
};

export type ResolveAgentOutputSchemaOptions = {
  readonly agent: LoadedAgentDefinition;
  readonly node: Extract<ConfiguredWorkflowRuntimeNode, { type: "agent" }>;
};

export type ResolveAgentSkillsOptions = {
  readonly agent: LoadedAgentDefinition;
  readonly cwd?: string;
  readonly state: WorkflowState;
};

export type WorkflowNodeRuntimeDependencies = {
  runBuiltInStep?: (options: RunBuiltInStepOptions) => MaybePromise<unknown>;
  agentRuntime?: AgentRuntimePort;
  resolveAgentTools?: (
    options: ResolveAgentToolCatalogOptions
  ) => MaybePromise<ResolvedToolCatalog>;
  resolveAgentOutputSchema?: (
    options: ResolveAgentOutputSchemaOptions
  ) => MaybePromise<unknown>;
  resolveAgentSkills?: (
    options: ResolveAgentSkillsOptions
  ) => MaybePromise<readonly ResolvedSkillReference[]>;
  runGatedAgentLoopStep?: (
    options: RunGatedAgentLoopStepOptions
  ) => MaybePromise<unknown>;
  builtInStepDependencies?: BuiltInStepDependencies;
};

export type WorkflowNodeRuntimeContext = {
  dependencies: WorkflowNodeRuntimeDependencies;
  agentsRoot: string;
  modelProfiles: ResolvedModelProfiles;
  workflowSubagentPolicy: WorkflowSubagentPolicy;
  observability?: LunaObservability;
  summary?: ObservabilitySummary;
  artifactStore?: ArtifactStore;
};

function resolveAgentModel(
  agent: LoadedAgentDefinition,
  modelProfiles: ResolvedModelProfiles
): ModelProfile {
  const profile = modelProfiles[agent.model_profile];

  if (profile === undefined) {
    throw configuredWorkflowError(
      `Model profile not found for agent ${agent.id}: ${agent.model_profile}`,
      "model_profile_missing"
    );
  }

  return profile;
}

function pathFromRecord(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const path = (value as { path?: unknown }).path;
  return typeof path === "string" && path !== "" ? path : undefined;
}

function agentCwdFromState(state: WorkflowState): string | undefined {
  return pathFromRecord(state.workspace) ?? pathFromRecord(state.repository);
}

function requireAgentCwd(
  agent: LoadedAgentDefinition,
  tools: ResolvedToolCatalog,
  state: WorkflowState
): string | undefined {
  const hasLocalTools = tools.tools.some((tool) => tool.protocol === "local");
  const cwd = agentCwdFromState(state);

  if (hasLocalTools && cwd === undefined) {
    throw configuredWorkflowError(
      `Agent ${agent.id} declares local tools but no repository or workspace path is available`,
      "agent_tool_cwd_missing"
    );
  }

  return cwd;
}

function requireRunHandle(state: WorkflowState): RunHandle {
  const run = state.run;
  if (
    typeof run !== "object" ||
    run === null ||
    Array.isArray(run) ||
    typeof (run as { run_id?: unknown }).run_id !== "string" ||
    typeof (run as { workflow_id?: unknown }).workflow_id !== "string" ||
    typeof (run as { attempt?: unknown }).attempt !== "number" ||
    typeof (run as { started_at?: unknown }).started_at !== "string"
  ) {
    throw configuredWorkflowError(
      "Agent node requires a run handle in workflow state",
      "agent_run_handle_missing"
    );
  }

  return run as RunHandle;
}

function validateGatedLoopCommands(value: unknown): ValidationCommand[] {
  const parsed = ValidationCommandSchema.array().safeParse(value);

  if (!parsed.success) {
    throw configuredWorkflowError(
      "Gated agent loop validation commands must resolve to structured validation commands",
      "gated_agent_loop_validation_commands_invalid",
      parsed.error
    );
  }

  return parsed.data;
}

function validatePositiveInteger(
  value: unknown,
  message: string,
  code: string
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw configuredWorkflowError(message, code);
  }

  return value;
}

function validateNonnegativeInteger(
  value: unknown,
  message: string,
  code: string
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw configuredWorkflowError(message, code);
  }

  return value;
}

function resolveGatedAgentLoopNode(
  node: GatedAgentLoopWorkflowNode,
  state: WorkflowState
): ResolvedGatedAgentLoopNode {
  const sandbox = resolveWorkflowInput(node.sandbox, state);
  const repair = resolveWorkflowInput(node.repair, state);
  const cwd = sandbox.cwd;

  if (typeof cwd !== "string" || cwd === "") {
    throw configuredWorkflowError(
      "Gated agent loop sandbox.cwd must resolve to a path",
      "gated_agent_loop_sandbox_cwd_invalid"
    );
  }

  return {
    ...node,
    sandbox: {
      type: "trusted_host_local",
      cwd,
      env_allowlist: node.sandbox.env_allowlist
    },
    gates: node.gates.map((gate) => {
      const resolvedGate = resolveWorkflowInput(gate, state);

      if (gate.type === "validation_commands") {
        return {
          ...gate,
          commands: validateGatedLoopCommands(resolvedGate.commands),
          max_output_bytes: validatePositiveInteger(
            resolvedGate.max_output_bytes,
            "Gated agent loop validation max_output_bytes must resolve to a number",
            "gated_agent_loop_validation_max_output_bytes_invalid"
          )
        };
      }

      return {
        ...gate,
        input:
          gate.input === undefined
            ? undefined
            : resolveWorkflowInput(gate.input, state)
      };
    }),
    repair: {
      attempts: validateNonnegativeInteger(
        repair.attempts,
        "Gated agent loop repair.attempts must resolve to a number",
        "gated_agent_loop_repair_attempts_invalid"
      )
    }
  };
}

export async function runWorkflowNode(
  node: ConfiguredWorkflowRuntimeNode,
  state: WorkflowState,
  context: WorkflowNodeRuntimeContext
): Promise<unknown> {
  if (node.type === "built_in") {
    const runBuiltInStep =
      context.dependencies.runBuiltInStep ?? defaultRunBuiltInStep;

    return await runBuiltInStep({
      uses: node.uses,
      state,
      input:
        node.input === undefined
          ? undefined
          : resolveWorkflowInput(node.input, state),
      dependencies: context.dependencies.builtInStepDependencies,
      observabilitySummary: context.summary
    });
  }

  if (node.type === "gated_agent_loop") {
    if (context.dependencies.runGatedAgentLoopStep === undefined) {
      throw configuredWorkflowError(
        `No gated agent loop runner configured for node: ${node.id}`,
        "gated_agent_loop_runner_missing"
      );
    }

    const agent = await loadAgentDefinition(context.agentsRoot, node.agent);
    const resolvedNode = resolveGatedAgentLoopNode(node, state);
    const gateAgents = Object.fromEntries(
      await Promise.all(
        resolvedNode.gates
          .filter((gate): gate is ResolvedAgentGate => gate.type === "agent")
          .map(async (gate) => [
            gate.id,
            await loadAgentDefinition(context.agentsRoot, gate.agent)
          ])
      )
    );

    return await context.dependencies.runGatedAgentLoopStep({
      agent,
      gateAgents,
      node: resolvedNode,
      model: resolveAgentModel(agent, context.modelProfiles),
      agentsRoot: context.agentsRoot,
      modelProfiles: context.modelProfiles,
      workflowSubagentPolicy: context.workflowSubagentPolicy,
      input: resolveWorkflowInput(node.input, state),
      sandbox: resolvedNode.sandbox,
      gates: resolvedNode.gates,
      repair: resolvedNode.repair,
      state,
      observability: context.observability,
      summary: context.summary,
      artifactStore: context.artifactStore
    });
  }

  const agentNode = node as Extract<ConfiguredWorkflowRuntimeNode, { type: "agent" }>;
  if (context.dependencies.agentRuntime === undefined) {
    throw configuredWorkflowError(
      `No agent runtime configured for node: ${node.id}`,
      "agent_runtime_missing"
    );
  }

  const agent = await loadAgentDefinition(context.agentsRoot, agentNode.agent);
  const model = resolveAgentModel(agent, context.modelProfiles);
  const input = resolveWorkflowInput(agentNode.input, state);

  const tools =
    await context.dependencies.resolveAgentTools?.({
      agent,
      node: agentNode,
      input,
      state
    }) ?? { tools: [], runtime_requirements: [] };
  const cwd = requireAgentCwd(agent, tools, state);
  const outputSchema =
    await context.dependencies.resolveAgentOutputSchema?.({
      agent,
      node: agentNode
    }) ?? agent.outputSchema;
  const skills =
    await context.dependencies.resolveAgentSkills?.({
      agent,
      cwd,
      state
    });
  const result = await runAgentNode({
    runtime: context.dependencies.agentRuntime,
    run: requireRunHandle(state),
    node_id: agentNode.id,
    agent,
    model_profile: model,
    input,
    output_schema: outputSchema,
    tools,
    skills,
    cwd,
    runtime_requirements: agentNode.runtime_requirements as
      | readonly AgentRuntimeRequirement[]
      | undefined
  });

  return result.output;
}

export const configuredWorkflowNodeRunner: ConfiguredWorkflowNodeRunner = {
  runNode: async ({ node, state, context }) =>
    await runWorkflowNode(node, state, context)
};
