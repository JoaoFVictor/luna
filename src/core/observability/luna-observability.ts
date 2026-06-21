import {
  customEvent,
  runCompletedEvent,
  runStartedEvent,
  stepFailedEvent,
  stepSkippedEvent,
  stepStartedEvent,
  stepSucceededEvent,
  type JsonObject,
  type LunaEvent,
  type LunaObservabilityLevel,
  type LunaObservabilitySink
} from "./events.js";
import { sanitizeJsonObject } from "./sanitize.js";

export {
  customEvent,
  runCompletedEvent,
  runStartedEvent,
  stepFailedEvent,
  stepSkippedEvent,
  stepStartedEvent,
  stepSucceededEvent,
  type JsonObject,
  type LunaEvent,
  type LunaObservabilityLevel,
  type LunaObservabilitySink
} from "./events.js";

export type CreateLunaObservabilityOptions = {
  run: {
    id: string;
    runtimeRunId?: string;
    attempt?: number;
  };
  workflow: {
    id: string;
  };
  sinks: LunaObservabilitySink[];
  now?: () => Date;
};

export type LunaObservability = {
  eventContext(severity: LunaObservabilityLevel): LunaEventContext;
  emit(event: LunaEvent): Promise<void>;
  close(): Promise<void>;
  isHardFailed(): boolean;
  hardFailure(): ObservabilityAppendError | undefined;
};

export type LunaEventContext = {
  severity: LunaObservabilityLevel;
  run: LunaEvent["run"];
  workflow: LunaEvent["workflow"];
  timestamp: string;
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

export function createLunaObservability({
  run,
  workflow,
  sinks,
  now = () => new Date()
}: CreateLunaObservabilityOptions): LunaObservability {
  let tail = Promise.resolve();
  let hardFailure: ObservabilityAppendError | undefined;
  const requiredSinks = sinks.filter((sink) => sink.required !== false);
  const eventRun = {
    id: run.id,
    ...(run.runtimeRunId === undefined
      ? {}
      : { runtimeRunId: run.runtimeRunId }),
    attempt: run.attempt ?? 1
  };

  function eventContext(severity: LunaObservabilityLevel): LunaEventContext {
    return {
      severity,
      run: eventRun,
      workflow,
      timestamp: now().toISOString()
    };
  }

  async function appendToRequiredSinks(event: LunaEvent): Promise<void> {
    for (const sink of requiredSinks) {
      try {
        await sink.append(event);
      } catch (cause) {
        hardFailure = appendError(sink, cause);
        throw hardFailure;
      }
    }
  }

  async function appendEvent(event: LunaEvent): Promise<void> {
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
      const warning = customEvent({
        ...eventContext("warn"),
        type: "luna.observability.sink.warning",
        outcome: { status: "skipped" },
        data: sanitizeJsonObject({
          sink_id: failure.sink.id ?? "unknown",
          required: false,
          error: failure.cause
        })
      });

      await appendToRequiredSinks(warning);
    }
  }

  return {
    eventContext,
    emit: async (event) => {
      if (hardFailure !== undefined) {
        throw hardFailure;
      }

      const next = tail.then(async () => {
        if (hardFailure !== undefined) {
          throw hardFailure;
        }

        await appendEvent(event);
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
