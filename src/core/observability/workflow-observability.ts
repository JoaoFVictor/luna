import { createTelemetryBufferSink } from "./sinks.js";
import {
  createObservabilityRecorder,
  type CreateObservabilityRecorderOptions,
  type LunaTelemetryRecord,
  type ObservabilityRecorder,
  type ObservabilitySink
} from "./tracing.js";
import {
  createSummaryProjection,
  type TraceSummaryProjection
} from "./summary-projection.js";

export type WorkflowObservability = {
  readonly recorder: ObservabilityRecorder;
  records(): readonly LunaTelemetryRecord[];
  snapshotSummary(): TraceSummaryProjection;
  close(): Promise<void>;
};

export function createWorkflowObservability({
  run,
  sinks,
  now,
  idGenerator
}: {
  readonly run: CreateObservabilityRecorderOptions["run"];
  readonly sinks: readonly ObservabilitySink[];
  readonly now?: () => Date;
  readonly idGenerator?: () => string;
}): WorkflowObservability {
  const buffer = createTelemetryBufferSink();
  const recorder = createObservabilityRecorder({
    run,
    sinks: [buffer, ...sinks],
    now,
    idGenerator
  });

  return {
    recorder,
    records: buffer.records,
    snapshotSummary: () => createSummaryProjection(buffer.records()),
    close: async () => {
      await recorder.close();
    }
  };
}
