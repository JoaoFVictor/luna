import { matchesJsonSchema } from "../../core/capabilities/json-schema.js";
import type { JsonSchemaLike } from "../../core/capabilities/pattern-registration.js";
import { assertCheckpointJsonValue } from "../../core/runtime/json.js";
import { runtimeError } from "../../core/runtime/errors.js";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import type {
  CompiledPatternEvidence,
  CompiledWorkflowNode
} from "../../core/workflow/compiler.js";
import type { ParsedWorkflowGate } from "../../core/workflow/definition-types.js";
import type {
  RunWorkflowInput,
  WorkflowPatternOccurrenceExecutor
} from "../../core/workflow/execution-contracts.js";
import { resolveWorkflowRuntimeValue } from "../../core/workflow/runner-input.js";
import type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
import {
  requirePatternAgentDefaults,
  runPatternAgent
} from "../agents/pattern-agent-runner.js";
import { gateResultFromAgentOutput } from "./gate-results.js";
import { gatedAgentGateKey } from "./gated-agent-loop-keys.js";
import type { RunGatesInput, RunGatesOutput } from "./gated-agent-loop.js";
import { runDurableJsonOccurrence } from "./gated-agent-loop-durability.js";
import { deterministicGateResult } from "./deterministic-gates.js";

const AGENT_REVIEW_GATE = "quality-gates.agent_review";

export async function runPatternGates({
  input,
  state,
  runtimeContext,
  node,
  evidence,
  gates,
  gateInput,
  cwd,
  runOccurrence
}: {
  readonly input: RunWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly node: CompiledWorkflowNode;
  readonly evidence: readonly CompiledPatternEvidence[];
  readonly gates: readonly ParsedWorkflowGate[];
  readonly gateInput: RunGatesInput;
  readonly cwd: string;
  readonly runOccurrence: WorkflowPatternOccurrenceExecutor;
}): Promise<RunGatesOutput> {
  const results = [];
  const outputs: Record<string, unknown> = {};
  let collectedEvidence: Record<string, unknown> | undefined;
  for (const [gateIndex, gate] of gates.entries()) {
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
      throw runtimeError(
        "Unsupported gated agent loop gate type",
        "runtime_unsupported_feature",
        { details: { node_id: node.id, gate_id: gate.id, gate_type: gate.type } }
      );
    }
    if (collectedEvidence === undefined && evidence.length > 0) {
      collectedEvidence = await runPatternEvidence({
        input,
        state,
        runtimeContext,
        evidence,
        gateInput,
        runOccurrence
      });
    }
    const gateContext = {
      output: gateInput.workerOutput,
      validation: gateInput.validation,
      diff_summary: gateInput.diffSummary,
      evidence: { ...(collectedEvidence ?? {}) },
      outputs: { ...outputs },
      attempt: gateInput.attempt,
      phase: gateInput.phase
    };
    const resolvedGateInput = await resolvePatternGateInput({
      input,
      state,
      runtimeContext,
      node,
      gate,
      gateIndex,
      gateContext
    });
    const reviewAgent = reviewAgentFromGateInput(node.id, gate, resolvedGateInput);
    const reviewDefaults = requirePatternAgentDefaults(
      input,
      gatedAgentGateKey(node.id, gate.id),
      node.id,
      reviewAgent
    );
    const reviewOutput = await runDurableJsonOccurrence({
      runOccurrence,
      attempt: gateInput.attempt,
      stageId: `reviewer:${gate.id}`,
      outputSchema: reviewDefaults.output_schema ?? {},
      path: `$.gate.outputs.${gate.id}`,
      execute: async () => await runPatternAgent({
        input,
        nodeId: gatedAgentGateKey(node.id, gate.id),
        agentId: reviewAgent,
        agentInput: resolvedGateInput,
        runtimeContext,
        cwd
      })
    });
    if (gate.block_when === undefined) {
      throw runtimeError(
        "Agent review gate requires block_when",
        "runtime_state_invalid",
        { details: { node_id: node.id, gate_id: gate.id } }
      );
    }
    results.push(await gateResultFromAgentOutput({
      id: gate.id,
      type: gate.type,
      blockWhen: gate.block_when,
      feedback: gate.feedback,
      output: reviewOutput,
      expressionRoot: { gate: reviewOutput }
    }));
    outputs[gate.id] = reviewOutput;
  }
  return {
    passed: results.every((result) => result.passed),
    results,
    outputs,
    ...(collectedEvidence === undefined ? {} : { evidence: collectedEvidence })
  };
}

async function runPatternEvidence({
  input,
  state,
  runtimeContext,
  evidence,
  gateInput,
  runOccurrence
}: {
  readonly input: RunWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly evidence: readonly CompiledPatternEvidence[];
  readonly gateInput: Omit<RunGatesInput, "evidence">;
  readonly runOccurrence: WorkflowPatternOccurrenceExecutor;
}): Promise<Record<string, unknown>> {
  const outputs: Record<string, unknown> = {};
  for (const entry of evidence) {
    const executor = input.builtIns[entry.node.capability_id];
    if (executor === undefined) {
      throw runtimeError(
        "No executor registered for pattern evidence built-in",
        "runtime_state_invalid",
        { details: { node_id: entry.node.id, capability_id: entry.node.capability_id } }
      );
    }
    const evidenceContext = {
      output: gateInput.workerOutput,
      validation: gateInput.validation,
      diff_summary: gateInput.diffSummary,
      evidence: { ...outputs },
      attempt: gateInput.attempt,
      phase: gateInput.phase
    };
    const resolvedInput = await resolveWorkflowRuntimeValue(
      entry.node.source.input ?? {},
      {
        root: gatedAgentLoopRuntimeRoot({
          input,
          state,
          runtimeContext,
          gate: evidenceContext
        }),
        path: `${entry.node.yaml_path}.input`,
        capability: entry.node.capability_id
      }
    );
    assertCheckpointJsonValue(resolvedInput, `${entry.node.yaml_path}.input`);
    const evidenceNode = {
      ...entry.node,
      id: `${entry.node.id}:attempt:${gateInput.attempt}`
    } satisfies CompiledWorkflowNode;
    const output = await runDurableJsonOccurrence({
      runOccurrence,
      attempt: gateInput.attempt,
      stageId: `evidence:${entry.id}`,
      outputSchema: entry.node.output_schema,
      path: `$.gate.evidence.${entry.id}`,
      execute: async () => {
        const value = await executor({
          node: evidenceNode,
          input: resolvedInput,
          state,
          runtimeContext,
          workflow: input.workflow,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(input.observability === undefined
            ? {}
            : { observability: input.observability })
        });
        if (!matchesJsonSchema(entry.node.output_schema as JsonSchemaLike, value)) {
          throw runtimeError(
            "Pattern evidence output failed schema validation",
            "runtime_node_output_schema_invalid",
            {
              details: {
                node_id: entry.node.id,
                yaml_path: entry.node.yaml_path,
                capability: entry.node.capability_id
              }
            }
          );
        }
        return value;
      }
    });
    outputs[entry.id] = output;
  }
  return outputs;
}

export async function resolvePatternGateInput({
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
    root: gatedAgentLoopRuntimeRoot({ input, state, runtimeContext, gate: gateContext }),
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
  throw runtimeError(
    "Agent review gate requires review_agent input",
    "runtime_state_invalid",
    { details: { node_id: nodeId, gate_id: gate.id } }
  );
}

export function gatedAgentLoopRuntimeRoot({
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
