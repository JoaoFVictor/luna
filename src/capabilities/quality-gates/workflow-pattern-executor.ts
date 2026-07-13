import { z } from "zod";
import {
  workspacePath
} from "../agents/agent-envelope.js";
import type { ParsedWorkflowGate } from "../../core/workflow/definition-types.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
import { runtimeError } from "../../core/runtime/errors.js";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import {
  ValidationCommandSchema,
  type ValidationCommand,
  type ValidationResult
} from "../../core/validation/types.js";
import { resolveWorkflowRuntimeValue } from "../../core/workflow/runner-input.js";
import {
  runGatedAgentLoopStateMachine,
  type RunGatesInput,
  type RunGatesOutput
} from "./gated-agent-loop.js";
import { gateResultFromAgentOutput } from "./gate-results.js";
import type {
  RunWorkflowInput,
  WorkflowPatternExecutor
} from "../../core/workflow/execution-contracts.js";
import {
  deterministicGateResult,
  VALIDATION_GATE
} from "./deterministic-gates.js";
import { gatedAgentGateKey, gatedAgentWorkerKey } from "./gated-agent-loop-keys.js";
import {
  requirePatternAgentDefaults,
  runPatternAgent
} from "../agents/pattern-agent-runner.js";

const GATED_AGENT_LOOP_CAPABILITY = "quality-gates.gated_agent_loop";
const AGENT_REVIEW_GATE = "quality-gates.agent_review";
const DEFAULT_DIFF_BYTES = 65_536;

export type QualityGatePatternDependencies = {
  readonly runValidationCommands: (input: {
    readonly cwd: string;
    readonly commands: readonly ValidationCommand[];
    readonly maxOutputBytes: number;
  }) => Promise<ValidationResult>;
  readonly collectDiffSummary: (input: {
    readonly cwd: string;
    readonly maxDiffBytes: number;
  }) => Promise<unknown>;
};

export function createQualityGatePatternExecutors(
  dependencies: QualityGatePatternDependencies
): Readonly<Record<string, WorkflowPatternExecutor>> {
  return Object.freeze({
    [GATED_AGENT_LOOP_CAPABILITY]: (input) =>
      executeGatedAgentLoopPattern(input, dependencies)
  });
}

const ValidationCommandsInputSchema = z
  .object({
    commands: z.array(ValidationCommandSchema),
    max_output_bytes: z.number().int().positive()
  })
  .strict();

export async function executeGatedAgentLoopPattern({
  workflowInput: input,
  state,
  runtimeContext,
  node,
  input: patternInput
}: {
  readonly workflowInput: RunWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly node: CompiledWorkflowNode;
  readonly input: unknown;
}, dependencies: QualityGatePatternDependencies
): Promise<unknown> {
  const source = requireGatedAgentLoopSource(node);
  const cwd = workspacePath(runtimeContext.workspace) ?? requirePatternAgentDefaults(
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
    prompt: patternInput,
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
          runtimeContext,
          cwd
        }),
      runValidation: async () =>
        await runValidationForGate(
          cwd,
          await validationConfig(),
          dependencies.runValidationCommands
        ),
      collectDiffSummary: async () =>
        await dependencies.collectDiffSummary({
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
          gateInput,
          cwd
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
  readonly input: RunWorkflowInput;
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
  readonly input: RunWorkflowInput;
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
  readonly input: RunWorkflowInput;
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
  config: { readonly commands: readonly ValidationCommand[]; readonly max_output_bytes: number } | undefined,
  runValidationCommands: QualityGatePatternDependencies["runValidationCommands"]
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
  gateInput,
  cwd
}: {
  readonly input: RunWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly node: CompiledWorkflowNode;
  readonly gates: readonly ParsedWorkflowGate[];
  readonly gateInput: RunGatesInput;
  readonly cwd: string;
}): Promise<RunGatesOutput> {
  const results = [];
  const outputs: Record<string, unknown> = {};
  for (const [gateIndex, gate] of gates.entries()) {
    const gateContext = {
      output: gateInput.workerOutput,
      validation: gateInput.validation,
      diff_summary: gateInput.diffSummary,
      outputs: { ...outputs },
      attempt: gateInput.attempt,
      phase: gateInput.phase
    };
    const deterministicResult = deterministicGateResult({
      gate,
      validation: gateInput.validation,
      diffSummary: gateInput.diffSummary
    });
    if (deterministicResult !== undefined) {
      results.push(deterministicResult);
      if (!deterministicResult.passed) {
        return { passed: false, results, outputs };
      }
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
      gateContext
    });
    const reviewAgent = reviewAgentFromGateInput(node.id, gate, resolvedGateInput);
    const reviewOutput = await runPatternAgent({
      input,
      nodeId: gatedAgentGateKey(node.id, gate.id),
      agentId: reviewAgent,
      agentInput: resolvedGateInput,
      runtimeContext,
      cwd
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
  readonly input: RunWorkflowInput;
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

function runtimeRoot({
  input,
  state,
  runtimeContext,
  gate
}: {
  readonly input: RunWorkflowInput;
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
