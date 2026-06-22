import {
  loadAgentDefinition,
  type AgentDefinition
} from "../agents/definition.js";
import {
  runBuiltInStep as defaultRunBuiltInStep
} from "../built-ins/executor.js";
import type {
  BuiltInStepDependencies,
  RunBuiltInStepOptions
} from "../built-ins/types.js";
import { resolveWorkflowInput, type WorkflowState } from "../workflow/state.js";
import type { WorkflowSubagentPolicy } from "../agents/subagent-policy.js";
import type { WorkflowNode } from "../workflow/definition.js";
import type { ResolvedModelProfiles } from "../config/models.js";
import type { ArtifactStore } from "../artifacts/store.js";
import type {
  ValidationCommand
} from "../validation/runner.js";
import type { ModelProfile } from "../config/schemas.js";
import { ValidationCommandSchema } from "../validation/runner.js";
import type {
  LunaObservability
} from "../observability/luna-observability.js";
import type { ObservabilitySummary } from "../observability/summary.js";
import { configuredWorkflowError } from "./errors.js";
import type { ConfiguredWorkflowNodeRunner } from "./contracts.js";

type MaybePromise<T> = T | Promise<T>;

type GatedAgentLoopWorkflowNode = Extract<
  WorkflowNode,
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

export type WorkflowNodeRuntimeDependencies = {
  runBuiltInStep?: (options: RunBuiltInStepOptions) => MaybePromise<unknown>;
  runAgentStep?: (options: RunAgentStepOptions) => MaybePromise<unknown>;
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
