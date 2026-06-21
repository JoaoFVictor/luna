import type { LunaEvent, LunaObservabilitySink } from "./events.js";
import { sanitizeAttributes } from "./sanitize.js";

type FlueLogAttributes = Record<string, unknown>;

type FlueLog = {
  info(message: string, attributes?: FlueLogAttributes): void;
  warn(message: string, attributes?: FlueLogAttributes): void;
  error(message: string, attributes?: FlueLogAttributes): void;
};

function errorAttributes(event: LunaEvent): FlueLogAttributes {
  const error =
    event.data?.error !== null && typeof event.data?.error === "object"
      ? (event.data.error as Record<string, unknown>)
      : undefined;

  return {
    ...(error?.code === undefined ? {} : { "error.code": error.code }),
    ...(error?.message === undefined ? {} : { "error.message": error.message })
  };
}

function attributesForEvent(event: LunaEvent): FlueLogAttributes {
  const attributes = sanitizeAttributes(event.data);
  const filteredAttributes = Object.fromEntries(
    Object.entries(attributes).filter(
      ([key]) => !key.startsWith("luna.") && !key.startsWith("error.")
    )
  );

  return {
    ...filteredAttributes,
    "luna.timestamp": event.timestamp,
    "luna.run_id": event.run.id,
    ...(event.run.flueRunId === undefined
      ? {}
      : { "luna.flue_run_id": event.run.flueRunId }),
    "luna.run_attempt": event.run.attempt,
    "luna.workflow_id": event.workflow.id,
    ...(event.step === undefined
      ? {}
      : {
          "luna.step_id": event.step.id,
          "luna.step_type": event.step.type
        }),
    ...(event.outcome === undefined
      ? {}
      : {
          "luna.outcome_status": event.outcome.status,
          ...(event.outcome.code === undefined
            ? {}
            : { "luna.outcome_code": event.outcome.code })
        }),
    ...errorAttributes(event)
  };
}

export function createFlueLogSink(log: FlueLog): LunaObservabilitySink {
  return {
    id: "flue-log",
    required: false,
    append: async (event) => {
      log[event.severity](event.type, attributesForEvent(event));
    }
  };
}
