import type { JsonValue } from "../../core/runtime/json.js";
import { BinaryAssetRefSchema } from "../../core/runtime/artifacts/binary-asset.js";
import {
  assertCheckpointJsonValue,
  isCheckpointPlainObject
} from "../../core/runtime/json.js";
import type { LunaRuntimeState, RuntimeArtifactRef } from "../../core/runtime/state.js";
import {
  runtimeError,
  RuntimeDurabilityRecoveryRequiredError
} from "../../core/runtime/errors.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";
import type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
import { resolveNodeInput, resolveWorkflowRuntimeValue } from "../../core/workflow/runner-input.js";
import { sha256Digest } from "../../core/workflow/definition-digests.js";
import { workflowLoopBodyNodeKey } from "../../core/workflow/loop-identity.js";
import { executeWorkflowNode } from "./node-executor.js";
import { publishArtifactsForNode } from "./node-artifacts.js";
import { assertNodeOutputMatchesSchema } from "./node-output-validation.js";
import { listCheckpointWritesForRecovery } from "./checkpoint-io.js";
import { waitForHumanInput, checkpointId, interruptId } from "./interrupts.js";
import {
  persistedNodeDurability,
  saveNodeCompletionAt,
  saveNodeOutputAt,
  type NodeDurabilityLocation,
  type PersistedNodeDurability
} from "./node-durability.js";

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
  const source = loopSource(node);
  const body = node.loop_body;
  if (body === undefined || body.length < 2) {
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
  let iterationArtifactRefs: RuntimeArtifactRef[] = [
    ...(continuation?.artifact_refs ?? [])
  ];
  let previousIterationArtifactRefs: RuntimeArtifactRef[] = [];

  if (continuation !== undefined) {
    bodySteps[gate.id] = continuation.decision;
    if (await repeatRequested(input, state, runtimeContext, node, source, bodySteps)) {
      iteration += 1;
      bodySteps = { ...bodySteps };
      previousIterationArtifactRefs = iterationArtifactRefs;
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
      iterationArtifactRefs = mergeRefs(
        iterationArtifactRefs,
        refsForLoopBodyNode(
          previousIterationArtifactRefs,
          node.id,
          bodyNode.id
        )
      );
      continue;
    }
    const durability = await loadLoopNodeDurability(input, node, bodyNode, iteration);
    let output: JsonValue;
    let artifactRefs: RuntimeArtifactRef[] = [];
    if (durability.kind === "completed") {
      output = durability.output;
      artifactRefs = durability.artifactRefs;
    } else {
      const executionNode = loopIterationExecutionNode(node, bodyNode, iteration);
      if (durability.kind === "output_pending") {
        output = durability.output;
      } else {
        const executionInput = loopIterationExecutionInput(
          input,
          node,
          bodyNode,
          executionNode
        );
        input.signal?.throwIfAborted();
        await executionInput.onBeforeNodeExecution?.({
          node_id: executionNode.id,
          attempt: 1
        });
        input.signal?.throwIfAborted();
        const raw = await executeWorkflowNode(
          executionInput,
          bodyState,
          runtimeContext,
          executionNode
        );
        assertNodeOutputMatchesSchema(executionNode, raw);
        assertCheckpointJsonValue(raw);
        output = raw;
        await saveNodeOutputAt({
          input,
          location: loopNodeDurabilityLocation(input, node, bodyNode, iteration),
          output
        });
      }
      bodyState = { ...bodyState, steps: { ...bodyState.steps, [bodyNode.id]: output } };
      try {
        artifactRefs = await publishArtifactsForNode(
          input,
          bodyNode,
          output,
          bodyState,
          loopIterationArtifactIdentity(node, bodyNode, iteration)
        );
        await saveNodeCompletionAt({
          input,
          location: loopNodeDurabilityLocation(input, node, bodyNode, iteration),
          output,
          artifactRefs,
          interruptRefs: []
        });
      } catch (cause) {
        throw new RuntimeDurabilityRecoveryRequiredError(
          "Workflow loop body output is durable but completion requires recovery",
          {
            cause,
            details: {
              loop_node_id: node.id,
              body_node_id: bodyNode.id,
              iteration
            }
          }
        );
      }
    }
    bodySteps[bodyNode.id] = output;
    iterationArtifactRefs = mergeRefs(iterationArtifactRefs, artifactRefs);
    bodyState = {
      ...bodyState,
      steps: { ...state.steps, ...bodySteps },
      artifact_refs: mergeRefs(bodyState.artifact_refs, artifactRefs)
    };
  }

  // The previous decision remains visible while conditional body nodes choose
  // what to regenerate. It must not masquerade as the decision for the new
  // review occurrence.
  delete bodySteps[gate.id];
  bodyState = loopBodyState(state, bodySteps);
  const reviewArtifactRefs = mergeRefs(
    iterationArtifactRefs,
    await verifiedBinaryAssetRefs({
      input,
      loop: node,
      body,
      bodySteps,
      trustedRefs: iterationArtifactRefs
    })
  );
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
      artifact_refs: reviewArtifactRefs
    }
  };
  const waitNode = { ...node, capability_id: gate.capability_id };
  const waiting = await waitForHumanInput(
    waitingInput,
    {
      ...state,
      artifact_refs: mergeRefs(state.artifact_refs, reviewArtifactRefs)
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

function loopIterationArtifactIdentity(
  loop: CompiledWorkflowNode,
  bodyNode: CompiledWorkflowNode,
  iteration: number
): { readonly node_id: string; readonly path_prefix: string } {
  return {
    node_id: `${loop.id}:iteration-${iteration}:${bodyNode.id}`,
    path_prefix: `loops/${loop.id}/iterations/${iteration}`
  };
}

function loopIterationExecutionNode(
  loop: CompiledWorkflowNode,
  bodyNode: CompiledWorkflowNode,
  iteration: number
): CompiledWorkflowNode {
  return {
    ...bodyNode,
    id: `${loop.id}:iteration-${iteration}:${bodyNode.id}`
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

function loopNodeCheckpointId(input: RunWorkflowInput, loop: CompiledWorkflowNode,
  bodyNode: CompiledWorkflowNode, iteration: number): string {
  const digest = sha256Digest({ workflow: input.compiled.workflow_revision, loop: loop.id })
    .slice("sha256:".length, "sha256:".length + 16);
  return `loop-node-v1-${input.run.run_id}-${digest}-${iteration}-${bodyNode.id}`;
}

function loopNodeDurabilityLocation(
  input: RunWorkflowInput,
  loop: CompiledWorkflowNode,
  bodyNode: CompiledWorkflowNode,
  iteration: number
): NodeDurabilityLocation {
  return {
    thread_id: input.run.run_id,
    checkpoint_ns: `loop/${loop.id}`,
    checkpoint_id: loopNodeCheckpointId(input, loop, bodyNode, iteration),
    task_id: loopIterationExecutionNode(loop, bodyNode, iteration).id
  };
}

async function loadLoopNodeDurability(input: RunWorkflowInput, loop: CompiledWorkflowNode,
  bodyNode: CompiledWorkflowNode, iteration: number): Promise<PersistedNodeDurability> {
  const location = loopNodeDurabilityLocation(input, loop, bodyNode, iteration);
  const writes = await listCheckpointWritesForRecovery({
    input,
    threadId: location.thread_id,
    checkpointNs: location.checkpoint_ns,
    checkpointId: location.checkpoint_id,
    operation: "load_loop_node_output"
  });
  return persistedNodeDurability({
    nodeId: location.task_id,
    writes
  });
}

function mergeRefs(current: RuntimeArtifactRef[], added: RuntimeArtifactRef[]): RuntimeArtifactRef[] {
  const refs = new Map(current.map((ref) => [ref.id, ref]));
  added.forEach((ref) => refs.set(ref.id, ref));
  return [...refs.values()];
}

function refsForLoopBodyNode(
  refs: RuntimeArtifactRef[],
  loopNodeId: string,
  bodyNodeId: string
): RuntimeArtifactRef[] {
  const physicalNodePrefix = `${loopNodeId}:iteration-`;
  const physicalNodeSuffix = `:${bodyNodeId}`;
  return refs.filter((ref) =>
    typeof ref.node_id === "string" &&
    ref.node_id.startsWith(physicalNodePrefix) &&
    ref.node_id.endsWith(physicalNodeSuffix)
  );
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

async function verifiedBinaryAssetRefs({
  input,
  loop,
  body,
  bodySteps,
  trustedRefs
}: {
  readonly input: RunWorkflowInput;
  readonly loop: CompiledWorkflowNode;
  readonly body: readonly CompiledWorkflowNode[];
  readonly bodySteps: Readonly<Record<string, JsonValue>>;
  readonly trustedRefs: readonly RuntimeArtifactRef[];
}): Promise<RuntimeArtifactRef[]> {
  const refs: RuntimeArtifactRef[] = [];
  const trusted = new Set(
    trustedRefs.map((ref) => `${ref.id}\u0000${ref.uri}\u0000${ref.node_id ?? ""}`)
  );
  const verify = input.artifactPublisher?.verify;

  const visit = async (
    candidate: JsonValue,
    owner: CompiledWorkflowNode
  ): Promise<void> => {
    if (Array.isArray(candidate)) {
      for (const nested of candidate) await visit(nested, owner);
      return;
    }
    if (!isCheckpointPlainObject(candidate)) return;
    const parsed = BinaryAssetRefSchema.safeParse(candidate);
    if (parsed.success) {
      const asset = parsed.data;
      if (!isLoopBodyAssetOwner(asset.node_id, loop.id, owner.id)) {
        throw runtimeError(
          "Workflow loop binary asset reference has an invalid owner",
          "runtime_state_invalid",
          {
            details: {
              loop_node_id: loop.id,
              body_node_id: owner.id,
              asset_id: asset.id
            }
          }
        );
      }
      const ref = { id: asset.id, uri: asset.uri, node_id: asset.node_id };
      const trustKey = `${ref.id}\u0000${ref.uri}\u0000${ref.node_id}`;
      if (!trusted.has(trustKey)) {
        if (verify === undefined || !(await verify.call(input.artifactPublisher, asset))) {
          throw runtimeError(
            "Workflow loop binary asset reference is not a committed artifact",
            "runtime_state_invalid",
            {
              details: {
                loop_node_id: loop.id,
                body_node_id: owner.id,
                asset_id: asset.id
              }
            }
          );
        }
      }
      refs.push(ref);
      return;
    }
    for (const nested of Object.values(candidate)) await visit(nested, owner);
  };

  for (const owner of body.slice(0, -1)) {
    const output = bodySteps[owner.id];
    if (output !== undefined) await visit(output, owner);
  }
  return refs;
}

function isLoopBodyAssetOwner(
  nodeId: string,
  loopNodeId: string,
  bodyNodeId: string
): boolean {
  const prefix = `${loopNodeId}:iteration-`;
  const suffix = `:${bodyNodeId}`;
  if (!nodeId.startsWith(prefix) || !nodeId.endsWith(suffix)) return false;
  const iteration = nodeId.slice(prefix.length, -suffix.length);
  return /^[1-9][0-9]*$/u.test(iteration) && Number.isSafeInteger(Number(iteration));
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
