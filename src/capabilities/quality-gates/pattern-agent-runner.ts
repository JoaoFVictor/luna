import type {
  AgentRuntimeRequirement
} from "../../core/agent-runtime/contracts.js";
import {
  runAgentNode
} from "../agents/agent-node.js";
import {
  requireAgentProjection,
  resolveAgentSkills,
  type AgentSkillSources
} from "../agents/agent-envelope.js";
import type { AgentDefinitionProjection } from "../agents/agent-definition.js";
import { requireWorkflowAgentTaskInput } from "../../core/workflow/agent-task-input.js";
import type { JsonSchemaLike } from "../../core/capabilities/json-schema-types.js";
import type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
import { runtimeError } from "../../core/runtime/errors.js";
import type { RunGatedWorkerInput } from "./gated-agent-loop.js";
import type {
  RunWorkflowInput,
  WorkflowAgentDefaults
} from "../../core/workflow/execution-contracts.js";
import { workflowAgentEventEmitter } from "../../core/workflow/events.js";

type QualityGateWorkflowAgentDefaults = Omit<
  WorkflowAgentDefaults,
  "agent" | "skill_sources"
> & {
  readonly agent: AgentDefinitionProjection;
  readonly skill_sources?: AgentSkillSources;
};

export async function runPatternAgent({
  input,
  nodeId,
  agentId,
  agentInput,
  runtimeContext,
  cwd
}: {
  readonly input: RunWorkflowInput;
  readonly nodeId: string;
  readonly agentId: string;
  readonly agentInput: RunGatedWorkerInput | unknown;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly cwd: string;
}): Promise<unknown> {
  const defaults = requireAgentDefaults(input, nodeId, nodeId, agentId);
  if (defaults.output_schema === undefined) {
    throw runtimeError("Pattern agent requires projected output schema", "runtime_state_invalid", {
      details: { node_id: nodeId, agent_id: agentId }
    });
  }

  const outputSchema = requireJsonSchema(defaults.output_schema, nodeId, agentId);
  const result = await runAgentNode({
    runtime: input.agentRuntime,
    run: input.run,
    node_id: nodeId,
    agent: requireAgentProjection({
      defaults,
      agentId
    }),
    input: requireWorkflowAgentTaskInput({
      input: agentInput,
      nodeId,
      agentId,
      message: "Pattern agent input must resolve to a JSON object"
    }),
    output_schema: outputSchema,
    model_profile: defaults.model_profile,
    tools: defaults.tools,
    skills: await resolveAgentSkills({
      skillSources: defaults.skill_sources,
      workspace: runtimeContext.workspace
    }),
    cwd,
    runtime_requirements: runtimeRequirementsForDefaults(defaults),
    signal: defaults.signal,
    events: defaults.events,
    observability: input.observability?.recorder,
    emitEvent: workflowAgentEventEmitter(input)
  });

  return result.output;
}

function requireJsonSchema(
  schema: unknown,
  nodeId: string,
  agentId: string
): JsonSchemaLike {
  if (typeof schema === "object" && schema !== null && !Array.isArray(schema)) {
    return schema as JsonSchemaLike;
  }

  throw runtimeError("Pattern agent output schema must be a JSON schema object", "runtime_state_invalid", {
    details: { node_id: nodeId, agent_id: agentId }
  });
}

export function requireAgentDefaults(
  input: RunWorkflowInput,
  key: string,
  nodeId: string,
  agentId: string
): QualityGateWorkflowAgentDefaults {
  const defaults = input.agentInputs?.[key];
  if (defaults === undefined) {
    throw runtimeError("Pattern agent requires projected runtime input", "runtime_state_invalid", {
      details: { node_id: nodeId, agent_id: agentId, agent_input_key: key }
    });
  }

  return defaults as QualityGateWorkflowAgentDefaults;
}

function runtimeRequirementsForDefaults(
  defaults: WorkflowAgentDefaults
): AgentRuntimeRequirement[] {
  return [
    ...new Set([
      ...(defaults.runtime_requirements ?? []),
      ...defaults.tools.runtime_requirements
    ])
  ] as AgentRuntimeRequirement[];
}
