import { randomUUID } from "node:crypto";
import type {
  LunaObservabilityEvent,
  LunaObservabilityLevel,
  LunaObservabilitySink
} from "./events.js";
import { sanitizeAttributes, sanitizeForObservability } from "./sanitize.js";

export type {
  LunaObservabilityEvent,
  LunaObservabilityLevel,
  LunaObservabilitySink
} from "./events.js";

export type CreateLunaObservabilityOptions = {
  run: {
    id: string;
    flueRunId?: string;
    attempt?: number;
  };
  workflow: {
    id: string;
  };
  sinks: LunaObservabilitySink[];
  now?: () => Date;
  createEventId?: () => string;
};

export type LunaObservability = {
  emit(
    level: LunaObservabilityLevel,
    event: string,
    attributes?: Record<string, unknown>
  ): Promise<void>;
  close(): Promise<void>;
  isHardFailed(): boolean;
  hardFailure(): ObservabilityAppendError | undefined;
};

type ObservabilityAppendError = Error & {
  code: "observability_append_failed";
  hardFailure: true;
  sinkId: string;
  cause: unknown;
};

function appendError(
  sink: LunaObservabilitySink,
  cause: unknown
): ObservabilityAppendError {
  const error = new Error("Failed to append observability event", {
    cause
  }) as ObservabilityAppendError;

  error.code = "observability_append_failed";
  error.hardFailure = true;
  error.sinkId = sink.id ?? "unknown";
  error.cause = cause;

  return error;
}

const TOP_LEVEL_KEYS = new Set([
  "step_id",
  "node_type",
  "agent_id",
  "subagent_id",
  "prompt_id",
  "status",
  "duration_ms",
  "error"
]);

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function splitEventFields(
  input: Record<string, unknown> | undefined
): {
  topLevel: Partial<LunaObservabilityEvent>;
  attributes: Record<string, unknown>;
} {
  const topLevel: Partial<LunaObservabilityEvent> = {};
  const attributes: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input ?? {})) {
    if (key === "attributes" && value !== null && typeof value === "object") {
      Object.assign(attributes, value as Record<string, unknown>);
      continue;
    }

    if (!TOP_LEVEL_KEYS.has(key)) {
      attributes[key] = value;
      continue;
    }

    if (key === "duration_ms") {
      const durationMs = numberValue(value);
      if (durationMs !== undefined) {
        topLevel.duration_ms = durationMs;
      }
      continue;
    }

    if (key === "error") {
      topLevel.error = sanitizeForObservability(value);
      continue;
    }

    const stringField = stringValue(value);
    if (stringField !== undefined) {
      (topLevel as Record<string, unknown>)[key] = stringField;
    }
  }

  return { topLevel, attributes: sanitizeAttributes(attributes) };
}

export function createLunaObservability({
  run,
  workflow,
  sinks,
  now = () => new Date(),
  createEventId = randomUUID
}: CreateLunaObservabilityOptions): LunaObservability {
  let sequence = 0;
  let tail = Promise.resolve();
  let hardFailure: ObservabilityAppendError | undefined;
  const requiredSinks = sinks.filter((sink) => sink.required !== false);

  function createEvent(
    level: LunaObservabilityLevel,
    event: string,
    attributes?: Record<string, unknown>
  ): LunaObservabilityEvent {
    sequence += 1;
    const split = splitEventFields(attributes);

    return {
      event,
      run_id: run.id,
      workflow_id: workflow.id,
      schema_version: 1,
      event_id: createEventId(),
      sequence,
      timestamp: now().toISOString(),
      level,
      ...(run.flueRunId === undefined ? {} : { flue_run_id: run.flueRunId }),
      ...(run.attempt === undefined ? {} : { run_attempt: run.attempt }),
      ...split.topLevel,
      ...(Object.keys(split.attributes).length === 0
        ? {}
        : { attributes: split.attributes })
    };
  }

  async function appendToRequiredSinks(event: LunaObservabilityEvent): Promise<void> {
    for (const sink of requiredSinks) {
      try {
        await sink.append(event);
      } catch (cause) {
        hardFailure = appendError(sink, cause);
        throw hardFailure;
      }
    }
  }

  async function appendEvent(event: LunaObservabilityEvent): Promise<void> {
    const optionalFailures: Array<{
      sink: LunaObservabilitySink;
      cause: unknown;
    }> = [];

    for (const sink of sinks) {
      try {
        await sink.append(event);
      } catch (cause) {
        if (sink.required === false) {
          optionalFailures.push({ sink, cause });
          continue;
        }

        hardFailure = appendError(sink, cause);
        throw hardFailure;
      }
    }

    for (const failure of optionalFailures) {
      const warning = createEvent("warn", "luna.observability.sink.warning", {
        sink_id: failure.sink.id ?? "unknown",
        required: false,
        error: sanitizeForObservability(failure.cause)
      });

      await appendToRequiredSinks(warning);
    }
  }

  return {
    emit: async (level, eventName, attributes) => {
      if (hardFailure !== undefined) {
        throw hardFailure;
      }

      const next = tail.then(async () => {
        if (hardFailure !== undefined) {
          throw hardFailure;
        }

        await appendEvent(createEvent(level, eventName, attributes));
      });

      tail = next.catch(() => undefined);

      await next;
    },
    close: async () => {
      await tail;
    },
    isHardFailed: () => hardFailure !== undefined,
    hardFailure: () => hardFailure
  };
}
