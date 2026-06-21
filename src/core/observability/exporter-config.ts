import type { WorkflowObservabilityConfig } from "../workflow/definition.js";
import type { LunaObservabilitySink } from "./events.js";

export type CreateObservabilitySinksOptions = {
  config: WorkflowObservabilityConfig;
  jsonlSink: LunaObservabilitySink;
  runtimeLogSinks?: readonly LunaObservabilitySink[];
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
  runtimeLogSinks
}: CreateObservabilitySinksOptions): LunaObservabilitySink[] {
  const sinks: LunaObservabilitySink[] = [
    withIdentity(jsonlSink, "jsonl", true)
  ];
  const runtimeLog = config.exporters.runtime_log;

  if (!runtimeLog.enabled) {
    return sinks;
  }

  const providedRuntimeLogSinks = runtimeLogSinks ?? [];

  if (providedRuntimeLogSinks.length === 0) {
    if (runtimeLog.required) {
      throw new Error("Required observability exporter runtime_log is unavailable");
    }

    return sinks;
  }

  for (const [index, sink] of providedRuntimeLogSinks.entries()) {
    sinks.push(
      withIdentity(
        sink,
        providedRuntimeLogSinks.length === 1
          ? "runtime_log"
          : `runtime_log:${index + 1}`,
        runtimeLog.required
      )
    );
  }

  return sinks;
}
