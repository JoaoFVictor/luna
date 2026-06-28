import { appendOnlyJsonlWriter } from "../artifacts/append-only-jsonl-writer.js";
import type { RuntimeLogStore } from "../runtime/backends/contracts.js";
import type {
  LunaTelemetryRecord,
  ObservabilitySink
} from "./tracing.js";

export type TelemetryBuffer = ObservabilitySink & {
  records(): readonly LunaTelemetryRecord[];
};

export function createTelemetryBufferSink(id = "buffer"): TelemetryBuffer {
  const records: LunaTelemetryRecord[] = [];

  return {
    id,
    required: true,
    emit(record) {
      records.push(cloneRecord(record));
    },
    records() {
      return records.map(cloneRecord);
    }
  };
}

export function createJsonlTraceSink({
  id = "jsonl",
  filePath,
  required = true
}: {
  id?: string;
  filePath: string;
  required?: boolean;
}): ObservabilitySink {
  return {
    id,
    required,
    async emit(record) {
      await appendOnlyJsonlWriter({ filePath, value: record });
    }
  };
}

export function createRuntimeLogProjectionSink({
  id = "runtime_log",
  runId,
  store,
  required = false
}: {
  id?: string;
  runId: string;
  store: RuntimeLogStore;
  required?: boolean;
}): ObservabilitySink {
  return {
    id,
    required,
    async emit(record) {
      const entry = runtimeLogEntry(record);
      if (entry === undefined) {
        return;
      }

      await store.append({
        run_id: runId,
        timestamp: entry.timestamp,
        level: entry.level,
        message: entry.message,
        ...(entry.nodeId === undefined ? {} : { node_id: entry.nodeId })
      });
    }
  };
}

function runtimeLogEntry(record: LunaTelemetryRecord):
  | {
      timestamp: string;
      level: "debug" | "info" | "warn" | "error";
      message: string;
      nodeId?: string;
    }
  | undefined {
  if (record.type === "span.started") {
    return {
      timestamp: record.span.started_at,
      level: "debug",
      message: `span started: ${record.span.name}`,
      nodeId: record.span.node_id
    };
  }

  if (record.type === "span.ended") {
    return {
      timestamp: record.span.ended_at ?? record.span.started_at,
      level: record.span.status === "error" ? "error" : "debug",
      message: `span ${record.span.status}: ${record.span.name}; duration_ms=${record.span.duration_ms ?? 0}`,
      nodeId: record.span.node_id
    };
  }

  if (record.type === "span.event") {
    return {
      timestamp: record.event.timestamp,
      level: "debug",
      message: `span event: ${record.event.name}`
    };
  }

  if (record.type === "log") {
    return {
      timestamp: record.log.timestamp,
      level: record.log.level,
      message: record.log.message,
      nodeId: record.log.node_id
    };
  }

  return undefined;
}

function cloneRecord<T extends LunaTelemetryRecord>(record: T): T {
  return JSON.parse(JSON.stringify(record)) as T;
}
