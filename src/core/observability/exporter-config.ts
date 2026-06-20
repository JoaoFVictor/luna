import type { WorkflowObservabilityConfig } from "../workflow-definition.js";
import type { LunaObservabilitySink } from "./events.js";

export type CreateObservabilitySinksOptions = {
  config: WorkflowObservabilityConfig;
  jsonlSink: LunaObservabilitySink;
  flueLogSink?: LunaObservabilitySink;
  flueLogSinks?: readonly LunaObservabilitySink[];
};

function withIdentity(
  sink: LunaObservabilitySink,
  id: string,
  required: boolean
): LunaObservabilitySink {
  return { ...sink, id, required };
}

export function createObservabilitySinks({
  config,
  jsonlSink,
  flueLogSink,
  flueLogSinks
}: CreateObservabilitySinksOptions): LunaObservabilitySink[] {
  const sinks: LunaObservabilitySink[] = [
    withIdentity(jsonlSink, "jsonl", true)
  ];
  const flueLog = config.exporters.flue_log;

  if (!flueLog.enabled) {
    return sinks;
  }

  const providedFlueLogSinks =
    flueLogSinks ?? (flueLogSink === undefined ? [] : [flueLogSink]);

  if (providedFlueLogSinks.length === 0) {
    if (flueLog.required) {
      throw new Error("Required observability exporter flue_log is unavailable");
    }

    return sinks;
  }

  for (const [index, sink] of providedFlueLogSinks.entries()) {
    sinks.push(
      withIdentity(
        sink,
        providedFlueLogSinks.length === 1 ? "flue_log" : `flue_log:${index + 1}`,
        flueLog.required
      )
    );
  }

  return sinks;
}
