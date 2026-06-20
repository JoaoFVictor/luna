import type { LunaObservabilityEvent, LunaObservabilitySink } from "./events.js";
import { sanitizeAttributes } from "./sanitize.js";

type FlueLogAttributes = Record<string, unknown>;

type FlueLog = {
  info(message: string, attributes?: FlueLogAttributes): void;
  warn(message: string, attributes?: FlueLogAttributes): void;
  error(message: string, attributes?: FlueLogAttributes): void;
};

function attributesForEvent(event: LunaObservabilityEvent): FlueLogAttributes {
  const attributes = sanitizeAttributes(event.attributes);
  const filteredAttributes = Object.fromEntries(
    Object.entries(attributes).filter(
      ([key]) => !key.startsWith("luna.") && !key.startsWith("error.")
    )
  );
  const error =
    event.error !== null && typeof event.error === "object"
      ? (event.error as Record<string, unknown>)
      : undefined;

  return {
    ...filteredAttributes,
    "luna.schema_version": event.schema_version,
    "luna.event_id": event.event_id,
    "luna.sequence": event.sequence,
    "luna.timestamp": event.timestamp,
    "luna.run_id": event.run_id,
    ...(event.flue_run_id === undefined
      ? {}
      : { "luna.flue_run_id": event.flue_run_id }),
    "luna.workflow_id": event.workflow_id,
    ...(event.run_attempt === undefined
      ? {}
      : { "luna.run_attempt": event.run_attempt }),
    ...(event.step_id === undefined ? {} : { "luna.step_id": event.step_id }),
    ...(event.node_type === undefined
      ? {}
      : { "luna.node_type": event.node_type }),
    ...(event.agent_id === undefined ? {} : { "luna.agent_id": event.agent_id }),
    ...(event.subagent_id === undefined
      ? {}
      : { "luna.subagent_id": event.subagent_id }),
    ...(event.prompt_id === undefined
      ? {}
      : { "luna.prompt_id": event.prompt_id }),
    ...(event.status === undefined ? {} : { "luna.status": event.status }),
    ...(event.duration_ms === undefined
      ? {}
      : { "luna.duration_ms": event.duration_ms }),
    ...(error?.code === undefined ? {} : { "error.code": error.code }),
    ...(error?.message === undefined ? {} : { "error.message": error.message })
  };
}

export function createFlueLogSink(log: FlueLog): LunaObservabilitySink {
  return {
    id: "flue-log",
    required: false,
    append: async (event) => {
      log[event.level](event.event, attributesForEvent(event));
    }
  };
}
