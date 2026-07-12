import {
  assertRefOnlyCheckpointState,
  type CheckpointWriteRecord,
  type CheckpointRecord,
  type CheckpointStore
} from "../../../core/runtime/backends/contracts.js";
import type { BackendRegistration } from "../../../core/runtime/backends/contracts.js";
import { runtimeError } from "../../../core/runtime/errors.js";
import { assertCheckpointJsonValue } from "../../../core/runtime/json.js";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";

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
        assertCheckpointJsonValue(record.value, "$.write.value");
        const key = `${record.thread_id}:${record.checkpoint_ns}:${record.checkpoint_id}`;
        const existing = writes.get(key) ?? [];
        const previous = existing.find(
          (write) =>
            write.task_id === record.task_id &&
            write.index === record.index
        );
        if (previous !== undefined) {
          if (
            previous.channel === record.channel &&
            isDeepStrictEqual(previous.value, record.value)
          ) {
            continue;
          }
          throw runtimeError(
            "Checkpoint write identity already belongs to different durable output",
            "runtime_duplicate_node_output",
            {
              details: {
                thread_id: record.thread_id,
                checkpoint_ns: record.checkpoint_ns,
                checkpoint_id: record.checkpoint_id,
                task_id: record.task_id,
                index: record.index
              }
            }
          );
        }
        existing.push(structuredClone(record));
        writes.set(key, existing);
      }
    },
    async listWrites(threadId, checkpointNs, checkpointId) {
      return structuredClone(writes.get(`${threadId}:${checkpointNs}:${checkpointId}`) ?? []);
    },
    async hasThreadWrites(threadId) {
      for (const records of writes.values()) {
        if (records.some((write) => write.thread_id === threadId)) {
          return true;
        }
      }
      return false;
    },
    async deleteThread(threadId) {
      checkpointsByThread.delete(threadId);
      for (const [key, records] of writes.entries()) {
        if (records.some((write) => write.thread_id === threadId)) {
          writes.delete(key);
        }
      }
    }
  };
}
