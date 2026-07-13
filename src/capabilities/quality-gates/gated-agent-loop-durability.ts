import type { GatedAgentLoopAttempt } from "../../core/agent-runtime/contracts.js";
import {
  runtimeDurabilityRecoveryRequiredFrom,
  runtimeError
} from "../../core/runtime/errors.js";
import {
  assertCheckpointJsonValue,
  isCheckpointPlainObject,
  type JsonValue
} from "../../core/runtime/json.js";
import type { WorkflowPatternOccurrenceExecutor } from "../../core/workflow/execution-contracts.js";

export async function runDurableWorkerOccurrence({
  runOccurrence,
  attempt,
  execute
}: {
  readonly runOccurrence: WorkflowPatternOccurrenceExecutor;
  readonly attempt: number;
  readonly execute: () => Promise<unknown>;
}): Promise<unknown> {
  const result = await runOccurrence({
    attempt,
    stage_id: "worker",
    output_schema: {},
    execute: async () => {
      try {
        const output = await execute();
        assertCheckpointJsonValue(output, "$.pattern.worker.output");
        return { kind: "output", output } as JsonValue;
      } catch (cause) {
        const durabilityFailure = runtimeDurabilityRecoveryRequiredFrom(cause);
        if (durabilityFailure !== undefined) throw durabilityFailure;
        return {
          kind: "error",
          error: serializableAgentError(cause)
        } as JsonValue;
      }
    }
  });
  return unwrapWorkerOccurrence(result);
}

export async function runDurableJsonOccurrence<T>({
  runOccurrence,
  attempt,
  stageId,
  outputSchema = {},
  path,
  execute
}: {
  readonly runOccurrence: WorkflowPatternOccurrenceExecutor;
  readonly attempt: number;
  readonly stageId: string;
  readonly outputSchema?: unknown;
  readonly path: string;
  readonly execute: () => Promise<T>;
}): Promise<T> {
  return await runOccurrence({
    attempt,
    stage_id: stageId,
    output_schema: outputSchema,
    execute: async () => {
      const output = await execute();
      assertCheckpointJsonValue(output, path);
      return output;
    }
  }) as T;
}

export async function persistDurableAttempt({
  runOccurrence,
  attempt
}: {
  readonly runOccurrence: WorkflowPatternOccurrenceExecutor;
  readonly attempt: GatedAgentLoopAttempt;
}): Promise<GatedAgentLoopAttempt> {
  return await runDurableJsonOccurrence({
    runOccurrence,
    attempt: attempt.attempt,
    stageId: "attempt",
    path: "$.pattern.attempt",
    execute: async () => attempt
  });
}

function serializableAgentError(cause: unknown): {
  readonly message: string;
  readonly code?: string;
} {
  const message = cause instanceof Error && cause.message.length > 0
    ? cause.message
    : String(cause || "Unknown agent error");
  const code = typeof (cause as { readonly code?: unknown })?.code === "string"
    ? (cause as { readonly code: string }).code
    : undefined;
  return { message, ...(code === undefined ? {} : { code }) };
}

function unwrapWorkerOccurrence(value: JsonValue): unknown {
  if (!isCheckpointPlainObject(value)) {
    throw invalidWorkerOutcome();
  }
  if (value.kind === "output" && "output" in value) return value.output;
  if (
    value.kind === "error" &&
    isCheckpointPlainObject(value.error) &&
    typeof value.error.message === "string"
  ) {
    const error = new Error(value.error.message) as Error & { code?: string };
    if (typeof value.error.code === "string") error.code = value.error.code;
    throw error;
  }
  throw invalidWorkerOutcome();
}

function invalidWorkerOutcome(): Error {
  return runtimeError(
    "Persisted pattern worker outcome is invalid",
    "runtime_state_invalid"
  );
}
