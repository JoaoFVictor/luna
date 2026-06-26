import {
  assertRefOnlyCheckpointState,
  type CheckpointWriteRecord,
  type CheckpointRecord,
  type CheckpointStore
} from "../../../core/runtime/backends/contracts.js";
import type { BackendRegistration } from "../../../core/runtime/backends/contracts.js";
import { runtimeError } from "../../../core/runtime/errors.js";
import { z } from "zod";

export const MemoryCheckpointBackendOptionsSchema = z.object({}).strict();
export const memoryCheckpointBackendRegistration = {
  id: "memory.checkpoints",
  kind: "checkpoint",
  optionsSchema: MemoryCheckpointBackendOptionsSchema
} satisfies BackendRegistration<z.infer<typeof MemoryCheckpointBackendOptionsSchema>>;

export function createMemoryCheckpointStore(): CheckpointStore {
  const checkpointsByThread = new Map<string, CheckpointRecord[]>();
  const writes = new Map<string, CheckpointWriteRecord[]>();

  return {
    async save(input) {
      assertRefOnlyCheckpointState(input.state);
      const checkpoints = checkpointsByThread.get(input.thread_id) ?? [];
      const previous = checkpoints.at(-1);
      const record: CheckpointRecord = {
        ...input,
        checkpoint_ns: input.checkpoint_ns ?? "",
        checkpoint: input.checkpoint ?? {
          v: 4,
          ts: input.created_at ?? new Date().toISOString(),
          channel_versions: {},
          versions_seen: {}
        },
        metadata: input.metadata ?? {},
        ...(input.parent_config === undefined ? {} : { parent_config: input.parent_config }),
        created_at: input.created_at ?? new Date().toISOString(),
        revision: (previous?.revision ?? 0) + 1
      };

      checkpoints.push(structuredClone(record));
      checkpointsByThread.set(input.thread_id, checkpoints);

      return structuredClone(record);
    },
    async load(threadId, options = {}) {
      const checkpoints = checkpointsByThread.get(threadId) ?? [];
      const record =
        options.checkpointId === undefined
          ? [...checkpoints]
              .reverse()
              .find((checkpoint) =>
                options.checkpointNs === undefined ||
                checkpoint.checkpoint_ns === options.checkpointNs
              )
          : checkpoints.find((checkpoint) =>
              checkpoint.checkpoint_id === options.checkpointId &&
              (options.checkpointNs === undefined ||
                checkpoint.checkpoint_ns === options.checkpointNs)
            );
      if (
        record !== undefined &&
        options.expectedStateSchemaVersion !== undefined &&
        record.state_schema_version !== options.expectedStateSchemaVersion
      ) {
        throw runtimeError(
          "Checkpoint state schema version is incompatible",
          "runtime_checkpoint_schema_mismatch",
          {
            details: {
              thread_id: threadId,
              expected: options.expectedStateSchemaVersion,
              actual: record.state_schema_version
            }
          }
        );
      }

      return record === undefined ? undefined : structuredClone(record);
    },
    async list(threadId, options = {}) {
      let checkpoints = [...(checkpointsByThread.get(threadId) ?? [])].reverse();
      if (options.checkpointNs !== undefined) {
        checkpoints = checkpoints.filter(
          (checkpoint) => checkpoint.checkpoint_ns === options.checkpointNs
        );
      }
      if (options.checkpointId !== undefined) {
        checkpoints = checkpoints.filter(
          (checkpoint) => checkpoint.checkpoint_id === options.checkpointId
        );
      }
      if (options.beforeCheckpointId !== undefined) {
        const beforeIndex = checkpoints.findIndex(
          (checkpoint) =>
            checkpoint.checkpoint_id === options.beforeCheckpointId &&
            (options.beforeCheckpointNs === undefined ||
              checkpoint.checkpoint_ns === options.beforeCheckpointNs)
        );
        checkpoints = beforeIndex < 0 ? [] : checkpoints.slice(beforeIndex + 1);
      }
      if (options.metadataFilter !== undefined) {
        checkpoints = checkpoints.filter((checkpoint) =>
          Object.entries(options.metadataFilter ?? {}).every(
            ([key, value]) => checkpoint.metadata[key] === value
          )
        );
      }

      return structuredClone(
        options.limit === undefined ? checkpoints : checkpoints.slice(0, options.limit)
      );
    },
    async saveWrites(records) {
      for (const record of records) {
        const key = `${record.thread_id}:${record.checkpoint_ns}:${record.checkpoint_id}`;
        const existing = (writes.get(key) ?? []).filter(
          (write) =>
            write.task_id !== record.task_id ||
            write.index !== record.index
        );
        existing.push(structuredClone(record));
        writes.set(key, existing);
      }
    },
    async listWrites(threadId, checkpointNs, checkpointId) {
      return structuredClone(writes.get(`${threadId}:${checkpointNs}:${checkpointId}`) ?? []);
    },
    async deleteThread(threadId) {
      checkpointsByThread.delete(threadId);
      for (const key of writes.keys()) {
        if (key.startsWith(`${threadId}:`)) {
          writes.delete(key);
        }
      }
    }
  };
}
