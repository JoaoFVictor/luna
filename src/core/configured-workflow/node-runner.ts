import {
  loadAgentDefinition,
  type AgentDefinition
} from "../agents/definition.js";
import {
  runBuiltInStep as defaultRunBuiltInStep
} from "../built-ins/index.js";
import type {
  BuiltInStepDependencies,
  RunBuiltInStepOptions
} from "../built-ins/types.js";
import { resolveWorkflowInput, type WorkflowState } from "../workflow-state.js";
import type { WorkflowSubagentPolicy } from "../agents/subagent-policy.js";
import type { WorkflowNode } from "../workflow-definition.js";
import type { ResolvedModelProfiles } from "../model-config.js";
import type { ArtifactStore } from "../artifact-store.js";
import type {
  ModelProfile,
  ValidationCommand
} from "../types.js";
import { ValidationCommandSchema } from "../types.js";
import type {
  LunaObservability
} from "../observability/luna-observability.js";
import type { ObservabilitySummary } from "../observability/summary.js";
import { configuredWorkflowError } from "../configured-workflow-errors.js";
import type { ConfiguredWorkflowNodeRunner } from "./contracts.js";

type MaybePromise<T> = T | Promise<T>;

type AgentLoopWorkflowNode = Extract<WorkflowNode, { type: "agent_loop" }>;

type ResolvedAgentLoopNode = Omit<
  AgentLoopWorkflowNode,
  "sandbox" | "validation" | "repair"
> & {
  sandbox: {
    type: "trusted_host_local";
    cwd: string;
    env_allowlist: string[];
  };
  validation: {
    commands: ValidationCommand[];
    max_output_bytes: number;
  };
  repair: {
    attempts: number;
  };
};

export type RunAgentStepOptions = {
  agent: AgentDefinition;
  node: Extract<WorkflowNode, { type: "agent" }>;
  model: ModelProfile;
  agentsRoot: string;
  modelProfiles: ResolvedModelProfiles;
  workflowSubagentPolicy: WorkflowSubagentPolicy;
  input: Record<string, unknown>;
  state: WorkflowState;
  observability?: LunaObservability;
  summary?: ObservabilitySummary;
  artifactStore?: ArtifactStore;
};

export type RunAgentLoopStepOptions = {
  agent: AgentDefinition;
  node: ResolvedAgentLoopNode;
  model: ModelProfile;
  agentsRoot: string;
  modelProfiles: ResolvedModelProfiles;
  workflowSubagentPolicy: WorkflowSubagentPolicy;
  input: Record<string, unknown>;
  sandbox: ResolvedAgentLoopNode["sandbox"];
  validation: ResolvedAgentLoopNode["validation"];
  repair: ResolvedAgentLoopNode["repair"];
  state: WorkflowState;
  observability?: LunaObservability;
  summary?: ObservabilitySummary;
  artifactStore?: ArtifactStore;
};

export type WorkflowNodeRuntimeDependencies = {
  runBuiltInStep?: (options: RunBuiltInStepOptions) => MaybePromise<unknown>;
  runAgentStep?: (options: RunAgentStepOptions) => MaybePromise<unknown>;
  runAgentLoopStep?: (
    options: RunAgentLoopStepOptions
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
  agent: AgentDefinition,
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

function validateAgentLoopCommands(value: unknown): ValidationCommand[] {
  const parsed = ValidationCommandSchema.array().safeParse(value);

  if (!parsed.success) {
    throw configuredWorkflowError(
      "Agent loop validation.commands must resolve to structured validation commands",
      "agent_loop_validation_commands_invalid",
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

function resolveAgentLoopNode(
  node: AgentLoopWorkflowNode,
  state: WorkflowState
): ResolvedAgentLoopNode {
  const sandbox = resolveWorkflowInput(node.sandbox, state);
  const validation = resolveWorkflowInput(node.validation, state);
  const repair = resolveWorkflowInput(node.repair, state);
  const cwd = sandbox.cwd;

  if (typeof cwd !== "string" || cwd === "") {
    throw configuredWorkflowError(
      "Agent loop sandbox.cwd must resolve to a path",
      "agent_loop_sandbox_cwd_invalid"
    );
  }

  return {
    ...node,
    sandbox: {
      type: "trusted_host_local",
      cwd,
      env_allowlist: node.sandbox.env_allowlist
    },
    validation: {
      commands: validateAgentLoopCommands(validation.commands),
      max_output_bytes: validatePositiveInteger(
        validation.max_output_bytes,
        "Agent loop validation.max_output_bytes must resolve to a number",
        "agent_loop_validation_max_output_bytes_invalid"
      )
    },
    repair: {
      attempts: validateNonnegativeInteger(
        repair.attempts,
        "Agent loop repair.attempts must resolve to a number",
        "agent_loop_repair_attempts_invalid"
      )
    }
  };
}

export async function runWorkflowNode(
  node: WorkflowNode,
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
      dependencies: context.dependencies.builtInStepDependencies
    });
  }

  if (node.type === "agent_loop") {
    if (context.dependencies.runAgentLoopStep === undefined) {
      throw configuredWorkflowError(
        `No agent loop runner configured for node: ${node.id}`,
        "agent_loop_runner_missing"
      );
    }

    const agent = await loadAgentDefinition(context.agentsRoot, node.agent);
    const resolvedNode = resolveAgentLoopNode(node, state);

    return await context.dependencies.runAgentLoopStep({
      agent,
      node: resolvedNode,
      model: resolveAgentModel(agent, context.modelProfiles),
      agentsRoot: context.agentsRoot,
      modelProfiles: context.modelProfiles,
      workflowSubagentPolicy: context.workflowSubagentPolicy,
      input: resolveWorkflowInput(node.input, state),
      sandbox: resolvedNode.sandbox,
      validation: resolvedNode.validation,
      repair: resolvedNode.repair,
      state,
      observability: context.observability,
      summary: context.summary,
      artifactStore: context.artifactStore
    });
  }

  if (context.dependencies.runAgentStep === undefined) {
    throw configuredWorkflowError(
      `No agent step runner configured for node: ${node.id}`,
      "agent_step_runner_missing"
    );
  }

  const agent = await loadAgentDefinition(context.agentsRoot, node.agent);

  return await context.dependencies.runAgentStep({
    agent,
    node,
    model: resolveAgentModel(agent, context.modelProfiles),
    agentsRoot: context.agentsRoot,
    modelProfiles: context.modelProfiles,
    workflowSubagentPolicy: context.workflowSubagentPolicy,
    input: resolveWorkflowInput(node.input, state),
    state,
    observability: context.observability,
    summary: context.summary,
    artifactStore: context.artifactStore
  });
}

export const configuredWorkflowNodeRunner: ConfiguredWorkflowNodeRunner = {
  runNode: async ({ node, state, context }) =>
    await runWorkflowNode(node, state, context)
};
