import { z } from "zod";
import type {
  AgentRuntimeRequirement,
  RunAgentInput
} from "../../core/agent-runtime/contracts.js";
import { matchesJsonSchema } from "../../core/capabilities/json-schema.js";
import type { JsonSchemaLike } from "../../core/capabilities/pattern-registration.js";
import type { ParsedWorkflowGate } from "../../core/workflow/definition-types.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
import { collectWorktreeDiff } from "../../core/git/diff/worktree-diff.js";
import { runtimeError } from "../../core/runtime/errors.js";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import {
  runValidationCommands,
  ValidationCommandSchema,
  type ValidationCommand,
  type ValidationResult
} from "../../core/validation/runner.js";
import { resolveWorkflowRuntimeValue } from "../../core/workflow/runner-input.js";
import {
  runGatedAgentLoopStateMachine,
  type RunGatedWorkerInput,
  type RunGatesInput,
  type RunGatesOutput
} from "../../capabilities/quality-gates/gated-agent-loop.js";
import { gateResultFromAgentOutput } from "../../capabilities/quality-gates/gate-results.js";
import type { RunCompiledWorkflowInput, WorkflowAgentDefaults } from "./workflow-runner.js";
import { gatedAgentGateKey, gatedAgentWorkerKey } from "./gated-agent-loop-keys.js";

const GATED_AGENT_LOOP_CAPABILITY = "quality-gates.gated_agent_loop";
const VALIDATION_GATE = "quality-gates.validation_commands";
const AGENT_REVIEW_GATE = "quality-gates.agent_review";
const DEFAULT_DIFF_BYTES = 65_536;

const ValidationCommandsInputSchema = z
  .object({
    commands: z.array(ValidationCommandSchema),
    max_output_bytes: z.number().int().positive()
  })
  .strict();

export async function executeGatedAgentLoopNode({
  input,
  state,
  runtimeContext,
  node,
  nodeInput
}: {
  readonly input: RunCompiledWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly node: CompiledWorkflowNode;
  readonly nodeInput: unknown;
}): Promise<unknown> {
  const source = requireGatedAgentLoopSource(node);
  const cwd = workspacePath(runtimeContext.workspace) ?? requireAgentDefaults(
    input,
    gatedAgentWorkerKey(node.id),
    node.id,
    source.worker
  ).cwd;
  if (cwd === undefined) {
    throw runtimeError("Gated agent loop requires a workspace cwd", "runtime_state_invalid", {
      details: { node_id: node.id }
    });
  }

  const validationConfig = createValidationConfigResolver({
    input,
    state,
    runtimeContext,
    node,
    gates: source.gates ?? []
  });

  return await runGatedAgentLoopStateMachine({
    cwd,
    prompt: nodeInput,
    repairAttempts: await repairAttemptsForNode({
      input,
      state,
      runtimeContext,
      node
    }),
    dependencies: {
      runWorker: async (workerInput) =>
        await runPatternAgent({
          input,
          nodeId: gatedAgentWorkerKey(node.id),
          agentId: source.worker,
          agentInput: workerInput,
          workflowMode: input.workflow.mode
        }),
      runValidation: async () =>
        await runValidationForGate(cwd, await validationConfig()),
      collectDiffSummary: async () =>
        await collectWorktreeDiff({
          cwd,
          maxDiffBytes: (await validationConfig())?.max_output_bytes ?? DEFAULT_DIFF_BYTES
        }),
      runGates: async (gateInput) =>
        await runPatternGates({
          input,
          state,
          runtimeContext,
          node,
          gates: source.gates ?? [],
          gateInput
        })
    }
  });
}

function requireGatedAgentLoopSource(node: CompiledWorkflowNode): {
  readonly worker: string;
  readonly gates?: readonly ParsedWorkflowGate[];
  readonly repair?: Record<string, unknown>;
} {
  if (
    node.kind !== "pattern" ||
    node.capability_id !== GATED_AGENT_LOOP_CAPABILITY ||
    node.source.type !== "pattern" ||
    typeof node.source.worker !== "string" ||
    node.source.worker.length === 0
  ) {
    throw runtimeError("Compiled gated agent loop node is invalid", "runtime_state_invalid", {
      details: { node_id: node.id }
    });
  }

  return node.source as {
    readonly worker: string;
    readonly gates?: readonly ParsedWorkflowGate[];
    readonly repair?: Record<string, unknown>;
  };
}

async function repairAttemptsForNode({
  input,
  state,
  runtimeContext,
  node
}: {
  readonly input: RunCompiledWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly node: CompiledWorkflowNode;
}): Promise<number> {
  const source = requireGatedAgentLoopSource(node);
  const attempts = await resolveWorkflowRuntimeValue(source.repair?.attempts ?? 0, {
    root: runtimeRoot({ input, state, runtimeContext }),
    path: `${node.yaml_path}.repair.attempts`,
    capability: node.capability_id
  });

  if (typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 0) {
    throw runtimeError("Gated agent loop repair attempts must be a nonnegative integer", "runtime_state_invalid", {
      details: { node_id: node.id, attempts }
    });
  }

  return attempts;
}

function createValidationConfigResolver({
  input,
  state,
  runtimeContext,
  node,
  gates
}: {
  readonly input: RunCompiledWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly node: CompiledWorkflowNode;
  readonly gates: readonly ParsedWorkflowGate[];
}): () => Promise<{ readonly commands: readonly ValidationCommand[]; readonly max_output_bytes: number } | undefined> {
  let resolved:
    | Promise<{ readonly commands: readonly ValidationCommand[]; readonly max_output_bytes: number } | undefined>
    | undefined;

  return () => {
    resolved ??= resolveValidationConfig({
      input,
      state,
      runtimeContext,
      node,
      gates
    });

    return resolved;
  };
}

async function resolveValidationConfig({
  input,
  state,
  runtimeContext,
  node,
  gates
}: {
  readonly input: RunCompiledWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly node: CompiledWorkflowNode;
  readonly gates: readonly ParsedWorkflowGate[];
}): Promise<{ readonly commands: readonly ValidationCommand[]; readonly max_output_bytes: number } | undefined> {
  const gateIndex = gates.findIndex((gate) => gate.type === VALIDATION_GATE);
  if (gateIndex < 0) {
    return undefined;
  }

  const gate = gates[gateIndex];
  const resolved = await resolveGateInput({
    input,
    state,
    runtimeContext,
    node,
    gate,
    gateIndex,
    gateContext: {}
  });

  return ValidationCommandsInputSchema.parse(resolved);
}

async function runValidationForGate(
  cwd: string,
  config: { readonly commands: readonly ValidationCommand[]; readonly max_output_bytes: number } | undefined
): Promise<ValidationResult> {
  if (config === undefined) {
    return { passed: true };
  }

  return await runValidationCommands({
    cwd,
    commands: config.commands,
    maxOutputBytes: config.max_output_bytes
  });
}

async function runPatternGates({
  input,
  state,
  runtimeContext,
  node,
  gates,
  gateInput
}: {
  readonly input: RunCompiledWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly node: CompiledWorkflowNode;
  readonly gates: readonly ParsedWorkflowGate[];
  readonly gateInput: RunGatesInput;
}): Promise<RunGatesOutput> {
  const results = [];
  const outputs: Record<string, unknown> = {};
  const baseGateContext = {
    output: gateInput.workerOutput,
    validation: gateInput.validation,
    diff_summary: gateInput.diffSummary,
    attempt: gateInput.attempt,
    phase: gateInput.phase
  };

  for (const [gateIndex, gate] of gates.entries()) {
    if (gate.type === VALIDATION_GATE) {
      results.push({
        id: gate.id,
        type: gate.type,
        passed: gateInput.validation.passed,
        ...(gateInput.validation.passed
          ? {}
          : { feedback: JSON.stringify(gateInput.validation.commands ?? []) }),
        output: gateInput.validation
      });
      continue;
    }

    if (gate.type !== AGENT_REVIEW_GATE) {
      throw runtimeError("Unsupported gated agent loop gate type", "runtime_unsupported_feature", {
        details: { node_id: node.id, gate_id: gate.id, gate_type: gate.type }
      });
    }

    const resolvedGateInput = await resolveGateInput({
      input,
      state,
      runtimeContext,
      node,
      gate,
      gateIndex,
      gateContext: baseGateContext
    });
    const reviewAgent = reviewAgentFromGateInput(node.id, gate, resolvedGateInput);
    const reviewOutput = await runPatternAgent({
      input,
      nodeId: gatedAgentGateKey(node.id, gate.id),
      agentId: reviewAgent,
      agentInput: resolvedGateInput,
      workflowMode: input.workflow.mode
    });

    if (gate.block_when === undefined) {
      throw runtimeError("Agent review gate requires block_when", "runtime_state_invalid", {
        details: { node_id: node.id, gate_id: gate.id }
      });
    }

    results.push(
      await gateResultFromAgentOutput({
        id: gate.id,
        type: gate.type,
        blockWhen: gate.block_when,
        feedback: gate.feedback,
        output: reviewOutput,
        expressionRoot: { gate: reviewOutput }
      })
    );
    outputs[gate.id] = reviewOutput;
  }

  return {
    passed: results.every((result) => result.passed),
    results,
    outputs
  };
}

async function resolveGateInput({
  input,
  state,
  runtimeContext,
  node,
  gate,
  gateIndex,
  gateContext
}: {
  readonly input: RunCompiledWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly node: CompiledWorkflowNode;
  readonly gate: ParsedWorkflowGate;
  readonly gateIndex: number;
  readonly gateContext: unknown;
}): Promise<unknown> {
  return await resolveWorkflowRuntimeValue(gate.input ?? {}, {
    root: runtimeRoot({ input, state, runtimeContext, gate: gateContext }),
    path: `${node.yaml_path}.gates[${gateIndex}].input`,
    capability: gate.type
  });
}

async function runPatternAgent({
  input,
  nodeId,
  agentId,
  agentInput,
  workflowMode
}: {
  readonly input: RunCompiledWorkflowInput;
  readonly nodeId: string;
  readonly agentId: string;
  readonly agentInput: RunGatedWorkerInput | unknown;
  readonly workflowMode: "read_only" | "trusted_local_write";
}): Promise<unknown> {
  const defaults = requireAgentDefaults(input, nodeId, nodeId, agentId);
  if (defaults.output_schema === undefined) {
    throw runtimeError("Pattern agent requires projected output schema", "runtime_state_invalid", {
      details: { node_id: nodeId, agent_id: agentId }
    });
  }

  const runtimeInput: RunAgentInput = {
    run: input.run,
    node_id: nodeId,
    agent_id: agentId,
    agent_mode: workflowMode,
    instructions: defaults.instructions,
    input: agentInput,
    output_schema: defaults.output_schema,
    model_profile: defaults.model_profile,
    tools: defaults.tools,
    context: defaults.context,
    ...(defaults.cwd === undefined ? {} : { cwd: defaults.cwd }),
    runtime_requirements: runtimeRequirementsForDefaults(defaults),
    signal: defaults.signal,
    events: defaults.events
  };

  await input.agentRuntime.validate(runtimeInput);
  const result = await input.agentRuntime.runAgent(runtimeInput);
  const outputSchema = requireJsonSchema(defaults.output_schema, nodeId, agentId);
  if (!matchesJsonSchema(outputSchema, result.output)) {
    throw runtimeError("Pattern agent output failed schema validation", "runtime_node_output_schema_invalid", {
      details: { node_id: nodeId, agent_id: agentId }
    });
  }

  return result.output;
}

function workspacePath(workspace: unknown): string | undefined {
  if (
    typeof workspace === "object" &&
    workspace !== null &&
    !Array.isArray(workspace) &&
    typeof (workspace as { path?: unknown }).path === "string"
  ) {
    return (workspace as { path: string }).path;
  }

  return undefined;
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

function requireAgentDefaults(
  input: RunCompiledWorkflowInput,
  key: string,
  nodeId: string,
  agentId: string
): WorkflowAgentDefaults {
  const defaults = input.agentInputs?.[key];
  if (defaults === undefined) {
    throw runtimeError("Pattern agent requires projected runtime input", "runtime_state_invalid", {
      details: { node_id: nodeId, agent_id: agentId, agent_input_key: key }
    });
  }

  return defaults;
}

function reviewAgentFromGateInput(
  nodeId: string,
  gate: ParsedWorkflowGate,
  input: unknown
): string {
  if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    typeof (input as { review_agent?: unknown }).review_agent === "string" &&
    (input as { review_agent: string }).review_agent.length > 0
  ) {
    return (input as { review_agent: string }).review_agent;
  }

  throw runtimeError("Agent review gate requires review_agent input", "runtime_state_invalid", {
    details: { node_id: nodeId, gate_id: gate.id }
  });
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

function runtimeRoot({
  input,
  state,
  runtimeContext,
  gate
}: {
  readonly input: RunCompiledWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly gate?: unknown;
}): unknown {
  return {
    invocation: input.invocation,
    config: input.config,
    run: input.run,
    repository: runtimeContext.repository,
    workspace: runtimeContext.workspace,
    steps: state.steps,
    ...(gate === undefined ? {} : { gate })
  };
}
