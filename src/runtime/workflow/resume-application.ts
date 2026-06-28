import { matchesJsonSchema } from "../../core/capabilities/json-schema.js";
import type { JsonSchemaLike } from "../../core/capabilities/json-schema-types.js";
import type {
  ResumeWorkflowInput,
  RunWorkflowInput
} from "../../core/workflow/execution-contracts.js";
import type { WorkflowRunResult } from "../../core/workflow/execution-contracts.js";
import { resumeInterrupt } from "../../core/runtime/interrupts/resume.js";
import {
  stableJson,
  type JsonValue
} from "../../core/runtime/json.js";
import {
  LUNA_RUNTIME_STATE_SCHEMA_VERSION,
  createInitialRuntimeState,
  publishNodeOutput,
  type LunaRuntimeState
} from "../../core/runtime/state.js";
import {
  startNodeAttempt,
  succeedNode
} from "../../core/runtime/lifecycle.js";
import { runtimeError } from "../../core/runtime/errors.js";
import type {
  CompiledWorkflowNode
} from "../../core/workflow/compiler.js";
import { finalWorkflowOutput } from "../../core/workflow/runner-output.js";
import { appendWorkflowEvent } from "../../core/workflow/events.js";
import {
  nodeOutputCheckpointId,
  saveNodeOutputWrite
} from "./checkpoints.js";
import { publishArtifactsForNode } from "./node-artifacts.js";
import {
  resumeContextFromMetadata
} from "./interrupts.js";
import {
  assertNodeOutputMatchesSchema
} from "./node-runner.js";
import { deferredFinalReportNodeIds } from "./deferred-final-report.js";

export type WorkflowResumeApplication<TInput extends ResumeWorkflowInput> = {
  readonly resumedInput: TInput & RunWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly startIndex: number;
  readonly terminalResult?: WorkflowRunResult;
};

export async function applyWorkflowResume<TInput extends ResumeWorkflowInput>(
  input: TInput
): Promise<WorkflowResumeApplication<TInput>> {
  const checkpoint = await input.backends.checkpoints.load(input.thread_id, {
    checkpointId: input.checkpoint_id,
    expectedStateSchemaVersion: LUNA_RUNTIME_STATE_SCHEMA_VERSION
  });
  if (checkpoint === undefined) {
    throw runtimeError("Checkpoint not found", "runtime_interrupt_not_found", {
      details: { checkpoint_id: input.checkpoint_id, thread_id: input.thread_id }
    });
  }
  if (checkpoint.metadata.workflow_revision !== input.workflow.revision) {
    throw runtimeError(
      "Checkpoint workflow revision is incompatible",
      "runtime_checkpoint_schema_mismatch",
      {
        details: {
          expected: input.workflow.revision,
          actual: checkpoint.metadata.workflow_revision
        }
      }
    );
  }
  if (checkpoint.state_schema_version !== input.compiled.state_schema_version) {
    throw runtimeError(
      "Checkpoint state schema is incompatible with compiled workflow",
      "runtime_checkpoint_schema_mismatch",
      {
        details: {
          expected: input.compiled.state_schema_version,
          actual: checkpoint.state_schema_version
        }
      }
    );
  }

  const resumeNodeId = String(checkpoint.metadata.resume_node_id ?? "");
  const resumeIndex = input.compiled.nodes.findIndex(
    (node) => node.id === resumeNodeId
  );
  if (resumeIndex < 0) {
    throw runtimeError("Resume node is not part of compiled workflow", "runtime_state_invalid", {
      details: { resume_node_id: resumeNodeId }
    });
  }

  const resumeContext = resumeContextFromMetadata(checkpoint.metadata);
  let state = createInitialRuntimeState({
    invocation: resumeContext.invocation,
    config: resumeContext.config,
    run: resumeContext.run,
    workflow: { id: input.workflow.id, mode: input.workflow.mode }
  });
  const priorWrites = await loadResumeStepWrites({
    input,
    resumeContext,
    checkpointNs: checkpoint.checkpoint_ns,
    checkpointId: input.checkpoint_id
  });
  state = {
    ...state,
    steps: Object.fromEntries(
      priorWrites.map((write) => [write.task_id, write.value])
    )
  };

  const resumeNode = input.compiled.nodes[resumeIndex];
  assertNodeOutputMatchesSchema(resumeNode, input.decision);
  const decisionAlreadyApplied = Object.prototype.hasOwnProperty.call(
    state.steps,
    resumeNodeId
  );
  if (
    decisionAlreadyApplied &&
    stableJson(state.steps[resumeNodeId]) !== stableJson(input.decision)
  ) {
    throw runtimeError(
      "Checkpoint resume decision conflicts with an already-applied decision",
      "interrupt_conflict",
      { details: { interrupt_id: input.interrupt_id, node_id: resumeNodeId } }
    );
  }

  const resume = await resumeInterrupt(
    {
      interrupt_id: input.interrupt_id,
      thread_id: input.thread_id,
      checkpoint_id: input.checkpoint_id,
      decision: input.decision
    },
    {
      interruptStore: input.backends.interrupts,
      eventStore: input.backends.events,
      resumeId: () => `resume-${input.interrupt_id}`
    }
  );
  await input.observability?.recorder.addEvent("interrupt.resumed", {
    interrupt_id: input.interrupt_id,
    checkpoint_id: input.checkpoint_id,
    node_id: resumeNodeId
  });

  const resumedInput = resumedInputFromContext(input, resumeContext);
  state = await applyResumeDecision({
    input: resumedInput,
    state,
    resumeNode,
    decisionAlreadyApplied,
    decision: input.decision,
    checkpointNs: checkpoint.checkpoint_ns,
    checkpointId: input.checkpoint_id,
    priorWrites
  });

  const startIndex = resumeIndex + 1;
  if (
    resume.already_resumed &&
    decisionAlreadyApplied &&
    remainingNodesAlreadyApplied(resumedInput.compiled.nodes, state, startIndex)
  ) {
    return {
      resumedInput,
      state,
      startIndex,
      terminalResult: terminalResultFromAppliedState(resumedInput, state, startIndex)
    };
  }

  return { resumedInput, state, startIndex };
}

function resumedInputFromContext<TInput extends ResumeWorkflowInput>(
  input: TInput,
  resumeContext: ReturnType<typeof resumeContextFromMetadata>
): TInput & RunWorkflowInput {
  return {
    ...input,
    run: resumeContext.run,
    invocation: resumeContext.invocation,
    config: resumeContext.config
  };
}

async function loadResumeStepWrites<TInput extends ResumeWorkflowInput>({
  input,
  resumeContext,
  checkpointNs,
  checkpointId
}: {
  readonly input: TInput;
  readonly resumeContext: ReturnType<typeof resumeContextFromMetadata>;
  readonly checkpointNs: string;
  readonly checkpointId: string;
}) {
  const resumeCheckpointWrites = await input.backends.checkpoints.listWrites(
    input.thread_id,
    checkpointNs,
    checkpointId
  );
  const nodeOutputWrites = await Promise.all(
    input.compiled.nodes.map((node) =>
      input.backends.checkpoints.listWrites(
        resumeContext.run.run_id,
        "",
        nodeOutputCheckpointId(resumeContext.run.run_id, node.id)
      )
    )
  );

  return [
    ...resumeCheckpointWrites,
    ...nodeOutputWrites.flat()
  ].filter((write) => write.channel === "steps");
}

async function applyResumeDecision<TInput extends RunWorkflowInput & ResumeWorkflowInput>({
  input,
  state,
  resumeNode,
  decisionAlreadyApplied,
  decision,
  checkpointNs,
  checkpointId,
  priorWrites
}: {
  readonly input: TInput;
  readonly state: LunaRuntimeState;
  readonly resumeNode: CompiledWorkflowNode;
  readonly decisionAlreadyApplied: boolean;
  readonly decision: JsonValue;
  readonly checkpointNs: string;
  readonly checkpointId: string;
  readonly priorWrites: readonly {
    readonly checkpoint_id: string;
    readonly task_id: string;
    readonly channel: string;
    readonly value: unknown;
  }[];
}): Promise<LunaRuntimeState> {
  let nextState = startNodeAttempt(state, resumeNode.id, 1);
  if (!decisionAlreadyApplied) {
    await input.backends.checkpoints.saveWrites([
      {
        thread_id: input.thread_id,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpointId,
        task_id: resumeNode.id,
        index: priorWrites.filter((write) => write.checkpoint_id === checkpointId).length,
        channel: "steps",
        value: decision
      }
    ]);
    await saveNodeOutputWrite({
      input,
      node: resumeNode,
      output: decision
    });
    nextState = publishNodeOutput(nextState, resumeNode.id, decision);
    const artifactRefs = await publishArtifactsForNode(
      input,
      resumeNode,
      decision,
      nextState
    );
    if (artifactRefs.length > 0) {
      nextState = {
        ...nextState,
        artifact_refs: [...nextState.artifact_refs, ...artifactRefs]
      };
    }
  }

  nextState = succeedNode(nextState, resumeNode.id);
  if (!decisionAlreadyApplied) {
    await appendWorkflowEvent(
      input,
      "node.succeeded",
      resumeNode.id
    );
  }

  return nextState;
}

function remainingNodesAlreadyApplied(
  nodes: readonly CompiledWorkflowNode[],
  state: LunaRuntimeState,
  startIndex: number
): boolean {
  return nodes
    .slice(startIndex)
    .every((node) => Object.prototype.hasOwnProperty.call(state.steps, node.id));
}

function terminalResultFromAppliedState(
  input: RunWorkflowInput,
  state: LunaRuntimeState,
  startIndex: number
): WorkflowRunResult {
  const output = finalWorkflowOutput(
    input.compiled,
    state,
    deferredFinalReportNodeIds(input, input.compiled.nodes.slice(startIndex))
  );
  if (!matchesJsonSchema(input.workflow.output_schema_content as JsonSchemaLike, output)) {
    throw runtimeError("Final workflow output failed schema validation", "runtime_node_output_schema_invalid", {
      details: { workflow_id: input.workflow.id }
    });
  }

  return {
    status: "succeeded",
    output,
    state: { ...state, run_status: "succeeded" }
  };
}
