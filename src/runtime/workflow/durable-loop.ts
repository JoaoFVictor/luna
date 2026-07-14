import type { JsonValue } from "../../core/runtime/json.js";
import { assertCheckpointJsonValue, isCheckpointPlainObject } from "../../core/runtime/json.js";
import type { LunaRuntimeState, RuntimeArtifactRef } from "../../core/runtime/state.js";
import { runtimeError } from "../../core/runtime/errors.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";
import type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
import { resolveNodeInput, resolveWorkflowRuntimeValue } from "../../core/workflow/runner-input.js";
import {
  loopBodyOccurrenceNodeId,
  workflowLoopBodyNodeKey
} from "../../core/workflow/loop-identity.js";
import { waitForHumanInput, checkpointId, interruptId } from "./interrupts.js";
import {
  runDurableNodeOccurrence
} from "./node-occurrence.js";
import { mergeRuntimeReferences } from "./runtime-reference-codec.js";

type LoopSource = Extract<CompiledWorkflowNode["source"], { readonly type: "loop" }>;

export type DurableLoopOutcome =
  | {
      readonly kind: "completed";
      readonly output: JsonValue;
      readonly halt_workflow: boolean;
    }
  | {
      readonly kind: "waiting_for_input";
      readonly interrupt_id: string;
      readonly checkpoint_id: string;
      readonly state: LunaRuntimeState;
    };

export async function runDurableLoop(input: RunWorkflowInput, state: LunaRuntimeState,
  runtimeContext: WorkflowRuntimeContext, node: CompiledWorkflowNode): Promise<DurableLoopOutcome> {
  if (node.kind !== "loop") {
    throw runtimeError("Compiled workflow loop node is invalid", "runtime_state_invalid", {
      details: { node_id: node.id }
    });
  }
  const source = loopSource(node);
  const body = node.loop_body;
  if (body.length < 2) {
    throw runtimeError("Compiled workflow loop body is invalid", "runtime_state_invalid", {
      details: { node_id: node.id }
    });
  }
  const gate = body.at(-1)!;
  if (gate.kind !== "interrupt") {
    throw runtimeError("Workflow loop must end with a human gate", "runtime_state_invalid", {
      details: { node_id: node.id }
    });
  }

  const continuation = input.loop_resume?.node_id === node.id
    ? input.loop_resume
    : undefined;
  let iteration = continuation?.iteration ?? 1;
  let bodySteps: Record<string, JsonValue> = { ...(continuation?.steps ?? {}) };
  let artifactsByNode: Record<string, RuntimeArtifactRef[]> = {
    ...(continuation?.artifacts_by_node ?? {})
  };
  let iterationArtifactRefs = mergeRuntimeReferences(
    Object.values(artifactsByNode).flat()
  );
  let previousArtifactsByNode: Record<string, RuntimeArtifactRef[]> = {};

  if (continuation !== undefined) {
    bodySteps[gate.id] = continuation.decision;
    if (await repeatRequested(input, state, runtimeContext, node, source, bodySteps)) {
      iteration += 1;
      bodySteps = { ...bodySteps };
      previousArtifactsByNode = artifactsByNode;
      artifactsByNode = {};
      iterationArtifactRefs = [];
    } else {
      const output = await loopResult(input, state, runtimeContext, node, source, bodySteps);
      return {
        kind: "completed",
        output,
        halt_workflow: await shouldHaltLoop(
          input,
          state,
          runtimeContext,
          node,
          output
        )
      };
    }
  }

  let bodyState = loopBodyState(state, bodySteps);
  for (const bodyNode of body.slice(0, -1)) {
    if (!(await bodyNodeEnabled(input, bodyState, runtimeContext, bodyNode))) {
      if (!Object.prototype.hasOwnProperty.call(bodySteps, bodyNode.id)) {
        throw runtimeError("Skipped workflow loop node has no previous output", "runtime_state_invalid", {
          details: { loop_node_id: node.id, body_node_id: bodyNode.id, iteration }
        });
      }
      const reusedRefs = previousArtifactsByNode[bodyNode.id] ?? [];
      artifactsByNode[bodyNode.id] = reusedRefs;
      iterationArtifactRefs = mergeRuntimeReferences(
        iterationArtifactRefs,
        reusedRefs
      );
      continue;
    }
    const executionNode = loopIterationExecutionNode(node, bodyNode, iteration);
    const executionInput = loopIterationExecutionInput(
      input,
      node,
      bodyNode,
      executionNode
    );
    const occurrence = await runDurableNodeOccurrence({
      input: executionInput,
      state: bodyState,
      runtimeContext,
      node: executionNode,
      projection: {
        state_node_id: bodyNode.id,
        artifact_path_prefix: `loops/${node.id}/iterations/${iteration}`,
        replace_existing_state: true,
        completion_failure: "recover"
      }
    });
    const output = occurrence.output;
    const artifactRefs = occurrence.artifact_refs;
    bodySteps[bodyNode.id] = output;
    artifactsByNode[bodyNode.id] = artifactRefs;
    iterationArtifactRefs = mergeRuntimeReferences(
      iterationArtifactRefs,
      artifactRefs
    );
    bodyState = {
      ...bodyState,
      steps: { ...state.steps, ...bodySteps },
      artifact_refs: mergeRuntimeReferences(
        bodyState.artifact_refs,
        artifactRefs
      )
    };
  }

  // The previous decision remains visible while conditional body nodes choose
  // what to regenerate. It must not masquerade as the decision for the new
  // review occurrence.
  delete bodySteps[gate.id];
  bodyState = loopBodyState(state, bodySteps);
  const reviewArtifactRefs = iterationArtifactRefs;
  const reviewInput = withReviewArtifacts(
    await resolveNodeInput(gate, bodyState, runtimeContext, input),
    reviewArtifactRefs
  );
  assertCheckpointJsonValue(reviewInput);
  const occurrence = `iteration-${iteration}`;
  const waitingInput: RunWorkflowInput = {
    ...input,
    loop_continuation: {
      node_id: node.id,
      iteration,
      steps: bodySteps,
      artifacts_by_node: artifactsByNode
    }
  };
  const waitNode = { ...node, capability_id: gate.capability_id };
  const waiting = await waitForHumanInput(
    waitingInput,
    {
      ...state,
      artifact_refs: mergeRuntimeReferences(
        state.artifact_refs,
        reviewArtifactRefs
      )
    },
    waitNode,
    reviewInput,
    { occurrence }
  );
  return {
    kind: "waiting_for_input",
    interrupt_id: interruptId(input.run.run_id, node.id, occurrence),
    checkpoint_id: checkpointId(input.run.run_id, node.id, occurrence),
    state: waiting
  };
}

export async function shouldHaltLoop(
  input: RunWorkflowInput,
  state: LunaRuntimeState,
  runtimeContext: WorkflowRuntimeContext,
  node: CompiledWorkflowNode,
  result: JsonValue
): Promise<boolean> {
  const source = loopSource(node);
  if (source.halt_when === undefined) return false;
  const value = await resolveWorkflowRuntimeValue(source.halt_when, {
    root: {
      ...runtimeRoot(input, state, runtimeContext, {}),
      result
    },
    path: `${node.yaml_path}.halt_when`,
    capability: node.capability_id
  });
  if (typeof value !== "boolean") {
    throw runtimeError("Workflow loop halt_when must resolve to a boolean", "runtime_state_invalid", {
      details: { node_id: node.id }
    });
  }
  return value;
}

function loopIterationExecutionNode(
  loop: CompiledWorkflowNode,
  bodyNode: CompiledWorkflowNode,
  iteration: number
): CompiledWorkflowNode {
  return {
    ...bodyNode,
    id: loopBodyOccurrenceNodeId({
      loop_node_id: loop.id,
      body_node_id: bodyNode.id,
      iteration
    })
  };
}

function loopIterationExecutionInput(
  input: RunWorkflowInput,
  loop: CompiledWorkflowNode,
  logicalNode: CompiledWorkflowNode,
  executionNode: CompiledWorkflowNode
): RunWorkflowInput {
  if (logicalNode.kind !== "agent") return input;
  const defaults = input.agentInputs?.[
    workflowLoopBodyNodeKey(loop.id, logicalNode.id)
  ];
  if (defaults === undefined) return input;
  return {
    ...input,
    agentInputs: {
      ...input.agentInputs,
      [executionNode.id]: defaults
    }
  };
}

function loopSource(node: CompiledWorkflowNode): LoopSource {
  if (node.kind !== "loop" || node.source.type !== "loop") {
    throw runtimeError("Compiled workflow loop source is invalid", "runtime_state_invalid", {
      details: { node_id: node.id }
    });
  }
  return node.source;
}

function loopBodyState(state: LunaRuntimeState, bodySteps: Record<string, JsonValue>): LunaRuntimeState {
  return { ...state, steps: { ...state.steps, ...bodySteps } };
}

async function repeatRequested(input: RunWorkflowInput, state: LunaRuntimeState,
  runtimeContext: WorkflowRuntimeContext, node: CompiledWorkflowNode, source: LoopSource,
  steps: Record<string, JsonValue>): Promise<boolean> {
  const value = await resolveWorkflowRuntimeValue(source.repeat_when, {
    root: runtimeRoot(input, state, runtimeContext, steps),
    path: `${node.yaml_path}.repeat_when`,
    capability: node.capability_id
  });
  if (typeof value !== "boolean") {
    throw runtimeError("Workflow loop repeat_when must resolve to a boolean", "runtime_state_invalid", {
      details: { node_id: node.id }
    });
  }
  return value;
}

async function loopResult(input: RunWorkflowInput, state: LunaRuntimeState,
  runtimeContext: WorkflowRuntimeContext, node: CompiledWorkflowNode, source: LoopSource,
  steps: Record<string, JsonValue>): Promise<JsonValue> {
  const value = await resolveWorkflowRuntimeValue(source.result, {
    root: runtimeRoot(input, state, runtimeContext, steps),
    path: `${node.yaml_path}.result`,
    capability: node.capability_id
  });
  assertCheckpointJsonValue(value);
  return value;
}

function runtimeRoot(input: RunWorkflowInput, state: LunaRuntimeState,
  runtimeContext: WorkflowRuntimeContext, steps: Record<string, JsonValue>) {
  return {
    invocation: input.invocation,
    config: input.config,
    run: input.run,
    repository: runtimeContext.repository,
    workspace: runtimeContext.workspace,
    steps: { ...state.steps, ...steps }
  };
}

async function bodyNodeEnabled(input: RunWorkflowInput, state: LunaRuntimeState,
  runtimeContext: WorkflowRuntimeContext, node: CompiledWorkflowNode): Promise<boolean> {
  const source = node.source;
  if ((source.type !== "agent" && source.type !== "built_in") || source.when === undefined) {
    return true;
  }
  const value = await resolveWorkflowRuntimeValue(source.when, {
    root: runtimeRoot(input, state, runtimeContext, state.steps),
    path: `${node.yaml_path}.when`,
    capability: node.capability_id
  });
  if (typeof value !== "boolean") {
    throw runtimeError("Workflow loop node when must resolve to a boolean", "runtime_state_invalid", {
      details: { node_id: node.id }
    });
  }
  return value;
}

function withReviewArtifacts(value: unknown, refs: RuntimeArtifactRef[]): unknown {
  if (!isCheckpointPlainObject(value) || !isCheckpointPlainObject(value.review)) {
    return value;
  }
  return {
    ...value,
    review: { ...value.review, artifact_refs: refs }
  };
}
