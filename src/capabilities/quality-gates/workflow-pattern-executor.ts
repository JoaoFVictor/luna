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
} from "./gated-agent-loop.js";
import type {
  RunWorkflowInput,
  WorkflowPatternOccurrenceExecutor,
  WorkflowPatternExecutor
} from "../../core/workflow/execution-contracts.js";
import {
  VALIDATION_GATE
} from "./deterministic-gates.js";
import { gatedAgentWorkerKey } from "./gated-agent-loop-keys.js";
import {
  requirePatternAgentDefaults,
  runPatternAgent
} from "../agents/pattern-agent-runner.js";
import {
  persistDurableAttempt,
  runDurableJsonOccurrence,
  runDurableWorkerOccurrence
} from "./gated-agent-loop-durability.js";
import {
  gatedAgentLoopRuntimeRoot,
  runPatternGates,
  resolvePatternGateInput
} from "./gated-agent-loop-gates.js";
import {
  ApprovedWorktreeSnapshotSchema,
  captureApprovedWorktreeSnapshot,
  worktreeSnapshotsEqual
} from "../git/worktree-snapshot.js";
import { WorktreeDiffSchema } from "../git/diff/worktree-diff.js";

const GATED_AGENT_LOOP_CAPABILITY = "quality-gates.gated_agent_loop";
const DEFAULT_DIFF_BYTES = 65_536;

export type QualityGatePatternDependencies = {
  readonly runValidationCommands: (input: {
    readonly cwd: string;
    readonly commands: readonly ValidationCommand[];
    readonly envAllowlist: readonly string[];
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
    env_allowlist: z.array(z.string().min(1)),
    max_output_bytes: z.number().int().positive()
  })
  .strict();

export async function executeGatedAgentLoopPattern({
  workflowInput: input,
  state,
  runtimeContext,
  node,
  input: patternInput,
  runOccurrence
}: {
  readonly workflowInput: RunWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
    readonly node: CompiledWorkflowNode;
    readonly input: unknown;
    readonly runOccurrence: WorkflowPatternOccurrenceExecutor;
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
      runWorker: async (workerInput) => {
        return await runDurableWorkerOccurrence({
          runOccurrence,
          attempt: workerInput.attempt,
          execute: async () => await runPatternAgent({
            input,
            nodeId: gatedAgentWorkerKey(node.id),
            agentId: source.worker,
            agentInput: workerInput,
            runtimeContext,
            cwd
          })
        });
      },
      runValidation: async ({ attempt }) => {
        return await runDurableJsonOccurrence({
          runOccurrence,
          attempt,
          stageId: "validation",
          path: "$.pattern.validation",
          execute: async () => await runValidationWithSnapshot({
            cwd,
            config: await validationConfig(),
            runValidationCommands: dependencies.runValidationCommands,
            ...(input.signal === undefined ? {} : { signal: input.signal })
          })
        }) as {
          readonly validation: ValidationResult;
          readonly validatedSnapshot: unknown;
        };
      },
      collectDiffSummary: async ({ attempt, validatedSnapshot }) => {
        const diffSummary = await runDurableJsonOccurrence({
          runOccurrence,
          attempt,
          stageId: "diff",
          path: "$.pattern.diff",
          execute: async () => await dependencies.collectDiffSummary({
            cwd,
            maxDiffBytes: DEFAULT_DIFF_BYTES
          })
        });
        if (validatedSnapshot !== undefined) {
          assertDiffMatchesValidatedSnapshot(diffSummary, validatedSnapshot);
        }
        return diffSummary;
      },
      runGates: async (gateInput) =>
        await runPatternGates({
          input,
          state,
          runtimeContext,
          node,
          evidence: node.kind === "pattern" ? node.evidence : [],
          gates: source.gates ?? [],
          gateInput,
          cwd,
          runOccurrence
        }),
      persistAttempt: async (attempt) => await persistDurableAttempt({
        runOccurrence,
        attempt
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
    root: gatedAgentLoopRuntimeRoot({ input, state, runtimeContext }),
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
}): () => Promise<{
  readonly commands: readonly ValidationCommand[];
  readonly env_allowlist: readonly string[];
  readonly max_output_bytes: number;
} | undefined> {
  let resolved:
    | Promise<{
        readonly commands: readonly ValidationCommand[];
        readonly env_allowlist: readonly string[];
        readonly max_output_bytes: number;
      } | undefined>
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
}): Promise<{
  readonly commands: readonly ValidationCommand[];
  readonly env_allowlist: readonly string[];
  readonly max_output_bytes: number;
} | undefined> {
  const gateIndex = gates.findIndex((gate) => gate.type === VALIDATION_GATE);
  if (gateIndex < 0) {
    return undefined;
  }

  const gate = gates[gateIndex];
  const resolved = await resolvePatternGateInput({
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
  config: {
    readonly commands: readonly ValidationCommand[];
    readonly env_allowlist: readonly string[];
    readonly max_output_bytes: number;
  } | undefined,
  runValidationCommands: QualityGatePatternDependencies["runValidationCommands"]
): Promise<ValidationResult> {
  if (config === undefined || config.commands.length === 0) {
    return { passed: true };
  }

  return await runValidationCommands({
    cwd,
    commands: config.commands,
    envAllowlist: config.env_allowlist,
    maxOutputBytes: config.max_output_bytes
  });
}

async function runValidationWithSnapshot(input: {
  readonly cwd: string;
  readonly config: Parameters<typeof runValidationForGate>[1];
  readonly runValidationCommands: QualityGatePatternDependencies["runValidationCommands"];
  readonly signal?: AbortSignal;
}): Promise<{
  readonly validation: ValidationResult;
  readonly validatedSnapshot: unknown;
}> {
  const before = await captureApprovedWorktreeSnapshot({
    cwd: input.cwd,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  const validation = await runValidationForGate(
    input.cwd,
    input.config,
    input.runValidationCommands
  );
  const after = await captureApprovedWorktreeSnapshot({
    cwd: input.cwd,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  if (!worktreeSnapshotsEqual(before, after)) {
    throw runtimeError(
      "Validation commands changed the worktree; validation must be read-only",
      "runtime_state_invalid",
      { details: { before_tree: before.tree_oid, after_tree: after.tree_oid } }
    );
  }
  return { validation, validatedSnapshot: after };
}

function assertDiffMatchesValidatedSnapshot(
  diffSummary: unknown,
  validatedSnapshot: unknown
): void {
  const diff = WorktreeDiffSchema.parse(diffSummary);
  const validated = ApprovedWorktreeSnapshotSchema.parse(validatedSnapshot);
  if (
    diff.approved_snapshot === undefined ||
    !worktreeSnapshotsEqual(diff.approved_snapshot, validated)
  ) {
    throw runtimeError(
      "Worktree changed between validation and diff collection",
      "runtime_state_invalid",
      {
        details: {
          validated_tree: validated.tree_oid,
          diff_tree: diff.approved_snapshot?.tree_oid
        }
      }
    );
  }
}
