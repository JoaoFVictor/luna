import { z } from "zod";
import type { ArtifactManifestStore } from "../artifacts/contracts.js";
import type { RuntimeEventStore } from "../events/contracts.js";
import type { InterruptStore } from "../interrupts/contracts.js";
import {
  assertCheckpointJsonObject,
  type JsonObject,
  type JsonValue
} from "../json.js";
import { runtimeError } from "../errors.js";

export type { JsonObject } from "../json.js";

export type BackendKind =
  | "artifact_manifest"
  | "event"
  | "interrupt"
  | "checkpoint"
  | "runtime_log";

export type BackendManifest = {
  id: string;
  kind: BackendKind;
  options: JsonObject;
};

export type BackendRegistration<TOptions extends JsonObject = JsonObject> = {
  id: string;
  kind: BackendKind;
  optionsSchema: z.ZodType<TOptions>;
};

export type RuntimeLogEntry = {
  run_id: string;
  sequence: number;
  timestamp: string;
  message: string;
  level?: "debug" | "info" | "warn" | "error";
  node_id?: string;
};

export type RuntimeLogInput = Omit<RuntimeLogEntry, "sequence"> & {
  sequence?: number;
};

export type RuntimeLogStore = {
  append(entry: RuntimeLogInput): Promise<RuntimeLogEntry>;
  list(runId: string): Promise<RuntimeLogEntry[]>;
};

export type CheckpointRecord = {
  thread_id: string;
  checkpoint_id: string;
  checkpoint_ns: string;
  state_schema_version: string;
  state: JsonObject;
  checkpoint: {
    v: number;
    ts: string;
    channel_versions: JsonObject;
    versions_seen: JsonObject;
  };
  metadata: JsonObject;
  parent_config?: JsonObject;
  created_at: string;
  revision: number;
};

export type SaveCheckpointInput = {
  thread_id: string;
  checkpoint_id: string;
  checkpoint_ns?: string;
  state_schema_version: string;
  state: JsonObject;
  checkpoint?: CheckpointRecord["checkpoint"];
  metadata?: JsonObject;
  parent_config?: JsonObject;
  created_at?: string;
};

export type LoadCheckpointOptions = {
  checkpointId?: string;
  checkpointNs?: string;
  expectedStateSchemaVersion?: string;
};

export type ListCheckpointsOptions = {
  checkpointNs?: string;
  checkpointId?: string;
  beforeCheckpointId?: string;
  beforeCheckpointNs?: string;
  limit?: number;
  metadataFilter?: Record<string, JsonValue>;
};

export type CheckpointWriteRecord = {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  index: number;
  channel: string;
  value: JsonValue;
};

export type CheckpointStore = {
  save(input: SaveCheckpointInput): Promise<CheckpointRecord>;
  load(
    threadId: string,
    options?: LoadCheckpointOptions
  ): Promise<CheckpointRecord | undefined>;
  list(
    threadId: string,
    options?: ListCheckpointsOptions
  ): Promise<CheckpointRecord[]>;
  saveWrites(writes: CheckpointWriteRecord[]): Promise<void>;
  listWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string
  ): Promise<CheckpointWriteRecord[]>;
  deleteThread(threadId: string): Promise<void>;
};

export type RuntimeBackends = {
  artifacts: ArtifactManifestStore;
  events: RuntimeEventStore;
  interrupts: InterruptStore;
  checkpoints: CheckpointStore;
  runtimeLogs: RuntimeLogStore;
};

const RefSchema = z
  .object({
    id: z.string().min(1),
    uri: z.string().min(1),
    node_id: z.string().min(1).optional()
  })
  .strict();

const RefOnlyCheckpointStateSchema = z
  .object({
    state_schema_version: z.string().min(1),
    run_status: z.string().min(1).optional(),
    artifact_refs: z.array(RefSchema).optional(),
    interrupt_refs: z.array(RefSchema).optional(),
    event_cursor: z.string().min(1).optional(),
    cursors: z.record(z.string().min(1)).optional()
  })
  .strict();

export function validateBackendManifest<TOptions extends JsonObject>(
  manifest: BackendManifest,
  registration: BackendRegistration<TOptions>
): TOptions {
  if (manifest.id !== registration.id || manifest.kind !== registration.kind) {
    throw runtimeError("Backend manifest does not match registration", "runtime_backend_invalid", {
      details: {
        manifest_id: manifest.id,
        manifest_kind: manifest.kind,
        registration_id: registration.id,
        registration_kind: registration.kind
      }
    });
  }

  const result = registration.optionsSchema.safeParse(manifest.options);
  if (!result.success) {
    throw runtimeError("Backend options failed schema validation", "runtime_backend_invalid", {
      cause: result.error,
      details: { backend_id: manifest.id }
    });
  }

  return result.data;
}

export function assertRefOnlyCheckpointState(state: JsonValue): asserts state is JsonObject {
  assertCheckpointJsonObject(state);
  const result = RefOnlyCheckpointStateSchema.safeParse(state);

  if (!result.success) {
    throw runtimeError("Checkpoint state must contain refs and cursors only", "runtime_checkpoint_not_ref_only", {
      cause: result.error
    });
  }
}
