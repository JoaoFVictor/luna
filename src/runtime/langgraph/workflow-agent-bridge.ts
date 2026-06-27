import type {
  AgentRuntimeRequirement
} from "../../core/agent-runtime/contracts.js";
import { runAgentNode } from "../../capabilities/agents/agent-node.js";
import {
  requireAgentProjection,
  resolveAgentSkills,
  type AgentSkillSources
} from "../../capabilities/agents/agent-envelope.js";
import type { AgentDefinitionProjection } from "../../capabilities/agents/agent-definition.js";
import { requireWorkflowAgentTaskInput } from "../../core/workflow/agent-task-input.js";
import { runtimeError } from "../../core/runtime/errors.js";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import { resolveNodeInput } from "../../core/workflow/runner-input.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
import { workflowAgentEventEmitter } from "./workflow-events.js";
import type {
  RunCompiledWorkflowInput,
  WorkflowAgentDefaults
} from "./workflow-runner-types.js";

type LangGraphWorkflowAgentDefaults = Omit<
  WorkflowAgentDefaults,
  "agent" | "skill_sources"
> & {
  readonly agent: AgentDefinitionProjection;
  readonly skill_sources?: AgentSkillSources;
};

export async function executeAgentNode({
  input,
  state,
  runtimeContext,
  node
}: {
  readonly input: RunCompiledWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly node: CompiledWorkflowNode;
}): Promise<unknown> {
  const source = node.source;
  if (source.type !== "agent") {
    throw runtimeError("Compiled agent node source is invalid", "runtime_state_invalid", {
      details: { node_id: node.id }
    });
  }

  const defaults = requireAgentDefaults(input, node);
  const requirements = runtimeRequirementsForNode(node, defaults);
  const result = await runAgentNode({
    runtime: input.agentRuntime,
    run: input.run,
    node_id: node.id,
    agent: requireAgentProjection({
      defaults,
      agentId: source.agent
    }),
    input: requireWorkflowAgentTaskInput(
      {
        input: await resolveNodeInput(node, state, runtimeContext, input),
        nodeId: node.id,
        message: "Agent node input must resolve to a JSON object"
      }
    ),
    output_schema: node.output_schema,
    model_profile: defaults.model_profile,
    tools: defaults.tools,
    skills: await resolveAgentSkills({
      skillSources: defaults.skill_sources,
      workspace: runtimeContext.workspace
    }),
    ...(defaults.cwd === undefined ? {} : { cwd: defaults.cwd }),
    runtime_requirements: requirements,
    signal: defaults.signal,
    events: defaults.events,
    observabilitySummary: input.observabilitySummary,
    emitEvent: workflowAgentEventEmitter(input)
  });
  return result.output;
}

export function runtimeRequirementsForNode(
  node: CompiledWorkflowNode,
  projectedInput?: WorkflowAgentDefaults
): AgentRuntimeRequirement[] {
  const sourceRequirements =
    node.source.type === "agent"
      ? ((node.source.runtime_requirements ?? []) as AgentRuntimeRequirement[])
      : [];
  const agentRequirements = projectedInput?.runtime_requirements ?? [];
  const toolRequirements = projectedInput?.tools.runtime_requirements ?? [];

  return [...new Set([...sourceRequirements, ...agentRequirements, ...toolRequirements])];
}

export function runtimeRequirementsForDefaults(
  projectedInput: WorkflowAgentDefaults
): AgentRuntimeRequirement[] {
  return [
    ...new Set([
      ...(projectedInput.runtime_requirements ?? []),
      ...projectedInput.tools.runtime_requirements
    ])
  ] as AgentRuntimeRequirement[];
}

function requireAgentDefaults(
  input: RunCompiledWorkflowInput,
  node: CompiledWorkflowNode
): LangGraphWorkflowAgentDefaults {
  const defaults = input.agentInputs?.[node.id];
  if (defaults === undefined) {
    throw runtimeError("Agent node requires projected runtime input", "runtime_state_invalid", {
      details: { node_id: node.id, agent_id: node.source.type === "agent" ? node.source.agent : undefined }
    });
  }

  return defaults as LangGraphWorkflowAgentDefaults;
}
