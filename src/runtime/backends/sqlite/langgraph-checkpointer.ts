import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type CheckpointPendingWrite,
  type PendingWrite,
  WRITES_IDX_MAP
} from "@langchain/langgraph-checkpoint";
import type {
  CheckpointRecord,
  CheckpointStore,
  CheckpointWriteRecord,
  JsonObject
} from "../../../core/runtime/backends/contracts.js";
import {
  assertCheckpointJsonObject,
  assertCheckpointJsonValue,
  type JsonValue
} from "../../../core/runtime/json.js";
import { assertRefOnlyCheckpointState } from "../../../core/runtime/backends/contracts.js";
import {
  isRuntimeDurabilityRecoveryRequired,
  RuntimeDurabilityRecoveryRequiredError
} from "../../../core/runtime/errors.js";

type RunnableConfig = CheckpointTuple["config"];
type ChannelVersion = string | number;
type VersionsSeen = Record<string, Record<string, ChannelVersion>>;

async function runJournalOperation<T>(
  operation: string,
  threadId: string,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (isRuntimeDurabilityRecoveryRequired(cause)) {
      throw cause;
    }
    throw new RuntimeDurabilityRecoveryRequiredError(
      "LangGraph checkpoint journal requires durable reconciliation",
      {
        cause,
        details: {
          operation,
          thread_id: threadId
        }
      }
    );
  }
}

function threadIdFromConfig(config: RunnableConfig): string {
  const threadId = config.configurable?.thread_id;
  if (typeof threadId !== "string" || threadId === "") {
    throw new Error("LangGraph checkpoint config requires configurable.thread_id");
  }

  return threadId;
}

function checkpointIdFromConfig(config: RunnableConfig): string | undefined {
  const checkpointId = config.configurable?.checkpoint_id;

  return typeof checkpointId === "string" && checkpointId !== ""
    ? checkpointId
    : undefined;
}

function checkpointNsFromConfig(config: RunnableConfig): string {
  const checkpointNs = config.configurable?.checkpoint_ns;

  return typeof checkpointNs === "string" ? checkpointNs : "";
}

function refOnlyStateFromCheckpoint(checkpoint: Checkpoint): JsonObject {
  assertCheckpointJsonObject(checkpoint.channel_values, "$.channel_values");
  const state = checkpoint.channel_values;
  const refOnlyState: JsonObject = {
    state_schema_version:
      typeof state.state_schema_version === "string"
        ? state.state_schema_version
        : "2026-06"
  };

  copyString(state, refOnlyState, "run_status");
  copyString(state, refOnlyState, "event_cursor");
  copyJsonValue(state, refOnlyState, "artifact_refs");
  copyJsonValue(state, refOnlyState, "interrupt_refs");
  copyJsonValue(state, refOnlyState, "cursors");
  assertRefOnlyCheckpointState(refOnlyState);

  return refOnlyState;
}

function copyString(source: JsonObject, target: JsonObject, key: string): void {
  const value = source[key];
  if (typeof value === "string") {
    target[key] = value;
  }
}

function copyJsonValue(source: JsonObject, target: JsonObject, key: string): void {
  const value = source[key];
  if (value !== undefined) {
    assertCheckpointJsonValue(value, `$.channel_values.${key}`);
    target[key] = value as JsonValue;
  }
}

function checkpointFromRecord(record: CheckpointRecord): Checkpoint {
  const channelVersions = channelVersionsFromJson(record.checkpoint.channel_versions);
  const versionsSeen = versionsSeenFromJson(record.checkpoint.versions_seen);

  return {
    v: record.checkpoint.v,
    id: record.checkpoint_id,
    ts: record.checkpoint.ts,
    channel_values: record.state,
    channel_versions: channelVersions,
    versions_seen: versionsSeen
  };
}

function channelVersionsFromJson(value: JsonObject): ChannelVersions {
  const versions: ChannelVersions = {};
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested !== "string" && typeof nested !== "number") {
      throw new Error(`Invalid LangGraph channel version for ${key}`);
    }
    versions[key] = nested;
  }

  return versions;
}

function versionsSeenFromJson(value: JsonObject): VersionsSeen {
  const seen: VersionsSeen = {};
  for (const [node, nested] of Object.entries(value)) {
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) {
      throw new Error(`Invalid LangGraph versions_seen for ${node}`);
    }

    seen[node] = channelVersionsFromJson(nested);
  }

  return seen;
}

function tupleFromRecord(
  record: CheckpointRecord,
  pendingWrites: CheckpointPendingWrite[] = []
): CheckpointTuple {
  return {
    config: {
      configurable: {
        thread_id: record.thread_id,
        checkpoint_ns: record.checkpoint_ns,
        checkpoint_id: record.checkpoint_id
      }
    },
    checkpoint: checkpointFromRecord(record),
    metadata: record.metadata as CheckpointMetadata,
    ...(record.parent_config === undefined
      ? {}
      : { parentConfig: record.parent_config as RunnableConfig }),
    ...(pendingWrites.length === 0 ? {} : { pendingWrites })
  };
}

function pendingWriteFromRecord(record: CheckpointWriteRecord): CheckpointPendingWrite {
  return [record.task_id, record.channel, record.value];
}

function parentConfigJson(config: RunnableConfig): JsonObject | undefined {
  const checkpointId = checkpointIdFromConfig(config);
  if (checkpointId === undefined) {
    return undefined;
  }

  return {
    configurable: {
      thread_id: threadIdFromConfig(config),
      checkpoint_ns: checkpointNsFromConfig(config),
      checkpoint_id: checkpointId
    }
  };
}

export class LunaLangGraphCheckpointer extends BaseCheckpointSaver {
  constructor(private readonly store: CheckpointStore) {
    super();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = threadIdFromConfig(config);
    const record = await runJournalOperation("load", threadId, async () =>
      await this.store.load(threadId, {
        checkpointId: checkpointIdFromConfig(config),
        checkpointNs: checkpointNsFromConfig(config)
      })
    );
    if (record === undefined) {
      return undefined;
    }

    const writes = await runJournalOperation("list_writes", threadId, async () =>
      await this.store.listWrites(
        threadId,
        record.checkpoint_ns,
        record.checkpoint_id
      )
    );
    return tupleFromRecord(record, writes.map(pendingWriteFromRecord));
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = threadIdFromConfig(config);
    const checkpointNs = checkpointNsFromConfig(config);
    const beforeConfig = options?.before ?? {};
    const beforeCheckpointId = checkpointIdFromConfig(beforeConfig);
    const records = await runJournalOperation("list", threadId, async () =>
      await this.store.list(threadId, {
        checkpointNs,
        checkpointId: checkpointIdFromConfig(config),
        beforeCheckpointId,
        beforeCheckpointNs:
          beforeCheckpointId === undefined
            ? undefined
            : checkpointNsFromConfig(beforeConfig),
        metadataFilter: options?.filter,
        limit: options?.limit
      })
    );

    for (const record of records) {
      const writes = await runJournalOperation("list_writes", threadId, async () =>
        await this.store.listWrites(
          threadId,
          record.checkpoint_ns,
          record.checkpoint_id
        )
      );
      yield tupleFromRecord(record, writes.map(pendingWriteFromRecord));
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    const threadId = threadIdFromConfig(config);
    const checkpointNs = checkpointNsFromConfig(config);
    const checkpointId = checkpoint.id;
    const state = refOnlyStateFromCheckpoint(checkpoint);
    const stateSchemaVersion =
      typeof state.state_schema_version === "string"
        ? state.state_schema_version
        : "2026-06";
    assertCheckpointJsonObject(metadata, "$.metadata");
    const parentConfig = parentConfigJson(config);

    await runJournalOperation("save", threadId, async () =>
      await this.store.save({
        thread_id: threadId,
        checkpoint_id: checkpointId,
        checkpoint_ns: checkpointNs,
        state_schema_version: stateSchemaVersion,
        state,
        checkpoint: {
          v: checkpoint.v,
          ts: checkpoint.ts,
          channel_versions: checkpoint.channel_versions,
          versions_seen: checkpoint.versions_seen
        },
        metadata,
        ...(parentConfig === undefined
          ? {}
          : { parent_config: parentConfig }),
        created_at: checkpoint.ts
      })
    );

    return {
      ...config,
      configurable: {
        ...config.configurable,
        thread_id: threadId,
        checkpoint_id: checkpointId,
        checkpoint_ns: checkpointNs
      },
      metadata: {
        ...config.metadata,
        checkpoint_source: metadata.source,
        checkpoint_step: metadata.step
      }
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    const threadId = threadIdFromConfig(config);
    const checkpointId = checkpointIdFromConfig(config);
    if (checkpointId === undefined) {
      throw new Error("LangGraph putWrites requires configurable.checkpoint_id");
    }

    const records = new Map<number, CheckpointWriteRecord>();
    for (const [index, [channel, value]] of writes.entries()) {
        assertCheckpointJsonValue(value, "$.write.value");
        const writeIndex = WRITES_IDX_MAP[channel] ?? index;
        // LangGraph assigns fixed negative indices to special channels. If a
        // single putWrites batch contains more than one value for such a
        // channel, its established contract is last-value-wins. Collapse the
        // in-memory batch before crossing the immutable durable-write boundary;
        // a later call still cannot replace the accepted identity.
        records.set(writeIndex, {
          thread_id: threadId,
          checkpoint_ns: checkpointNsFromConfig(config),
          checkpoint_id: checkpointId,
          task_id: taskId,
          index: writeIndex,
          channel,
          value
        });
    }
    await runJournalOperation("save_writes", threadId, async () =>
      await this.store.saveWrites([...records.values()])
    );
  }

  async deleteThread(threadId: string): Promise<void> {
    await runJournalOperation("delete_thread", threadId, async () =>
      await this.store.deleteThread(threadId)
    );
  }
}

export function createLangGraphCheckpointer(
  store: CheckpointStore
): BaseCheckpointSaver {
  return new LunaLangGraphCheckpointer(store);
}
