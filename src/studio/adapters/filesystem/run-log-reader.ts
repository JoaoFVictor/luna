import { z } from "zod";
import {
  RunLogListQuerySchema,
  RunLogPageSchema,
  type RunLogPage,
  type StudioRunLogEntry
} from "../../contracts/run-logs.js";
import { RunOpaqueIdSchema } from "../../contracts/runs.js";
import {
  RunLogReaderError,
  type RunLogReaderPort
} from "../../application/runs/log-ports.js";
import {
  createRunLogCursorCodec,
  createRunLogCursorKey,
  createRunLogSnapshotFingerprint,
  createRunLogSnapshotNonce,
  runLogQueryHash,
  type RunLogCursorEnvelope
} from "./run-log-cursor.js";
import {
  openSecureRegularFile,
  SecureReadFileError,
  type SecureReadonlyFile
} from "./secure-read-file.js";
import {
  RunLogSnapshotCache,
  type CachedRunLogSnapshot
} from "./run-log-snapshot-cache.js";
import { redactStudioText } from "../redaction/text.js";

const DEFAULT_CURSOR_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_SCAN_BYTES = 2 * 1024 * 1024;
const DEFAULT_READ_CHUNK_BYTES = 32 * 1024;
const DEFAULT_MAX_SNAPSHOT_CACHE_ENTRIES = 16;

const StoredRuntimeLogEntrySchema = z
  .object({
    run_id: RunOpaqueIdSchema,
    sequence: z.number().int().safe().positive(),
    timestamp: z.string().datetime({ offset: true }),
    message: z.string().max(65_536),
    level: z.enum(["debug", "info", "warn", "error"]).optional(),
    node_id: z.string().min(1).max(256).optional()
  })
  .strict();

type StoredRuntimeLogEntry = z.infer<typeof StoredRuntimeLogEntrySchema>;

export type FilesystemRunLogReaderOptions = {
  readonly root: string;
  readonly cursorKey?: Uint8Array;
  readonly cursorTtlMs?: number;
  readonly maxLineBytes?: number;
  readonly maxSnapshotBytes?: number;
  readonly maxScanBytes?: number;
  readonly readChunkBytes?: number;
  readonly maxSnapshotCacheEntries?: number;
  readonly maxSnapshotCacheBytes?: number;
  readonly snapshotCacheTtlMs?: number;
  readonly now?: () => Date;
};

type ScannedLine = {
  readonly content: Buffer;
  readonly nextOffset: number;
};

function positiveSafeInteger(
  value: number,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function logError(
  code: RunLogReaderError["code"],
  message: string,
  details: Readonly<Record<string, string | number | boolean | null>> = {}
): RunLogReaderError {
  return new RunLogReaderError(code, message, details);
}

function mapSecureReadError(error: SecureReadFileError): RunLogReaderError {
  switch (error.code) {
    case "security_violation":
      return logError(
        "run_log_security_violation",
        "Run logs failed path security checks"
      );
    case "size_unsupported":
      return logError("run_log_snapshot_too_large", "Run log size is unsupported");
    case "missing":
    case "not_regular_file":
      return logError("run_log_changed", "Run log snapshot is no longer available");
    case "io_failed":
      return logError("run_log_io_failed", "Run logs could not be read");
  }
}

function parseStoredLine(
  line: Buffer,
  expectedRunId: string,
  maxLineBytes: number
): StoredRuntimeLogEntry {
  if (line.byteLength > maxLineBytes) {
    throw logError(
      "run_log_line_too_large",
      "Run log entry exceeds the configured size limit",
      { max_line_bytes: maxLineBytes }
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(line);
  } catch {
    throw logError("run_log_store_corrupt", "Run log entry encoding is invalid");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw logError("run_log_store_corrupt", "Run log entry is invalid");
  }
  const parsed = StoredRuntimeLogEntrySchema.safeParse(raw);
  if (!parsed.success || parsed.data.run_id !== expectedRunId) {
    throw logError("run_log_store_corrupt", "Run log entry is invalid");
  }
  return parsed.data;
}

function* scanLines(options: {
  readonly content: Buffer;
  readonly start: number;
  readonly end: number;
  readonly maxLineBytes: number;
}): Generator<ScannedLine> {
  let lineStart = options.start;
  while (lineStart < options.end) {
    const locatedNewline = options.content.indexOf(0x0a, lineStart);
    const newline = locatedNewline >= 0 && locatedNewline < options.end
      ? locatedNewline
      : options.end;
    let lineEnd = newline;
    if (lineEnd > lineStart && options.content[lineEnd - 1] === 0x0d) {
      lineEnd -= 1;
    }
    const lineBytes = lineEnd - lineStart;
    if (lineBytes > options.maxLineBytes) {
      throw logError(
        "run_log_line_too_large",
        "Run log entry exceeds the configured size limit",
        { max_line_bytes: options.maxLineBytes }
      );
    }
    yield {
      content: Buffer.from(options.content.subarray(lineStart, lineEnd)),
      nextOffset: newline < options.end ? newline + 1 : options.end
    };
    lineStart = newline < options.end ? newline + 1 : options.end;
  }
}

function queryIdentity(query: z.infer<typeof RunLogListQuerySchema>): unknown {
  return {
    run_id: query.run_id,
    levels: [...query.levels].sort(),
    node_id: query.node_id ?? null
  };
}

function matchesFilters(
  entry: StoredRuntimeLogEntry,
  query: z.infer<typeof RunLogListQuerySchema>
): boolean {
  return (query.levels.length === 0 ||
      (entry.level !== undefined && query.levels.includes(entry.level))) &&
    (query.node_id === undefined || entry.node_id === query.node_id);
}

function publicEntry(entry: StoredRuntimeLogEntry): StudioRunLogEntry {
  return {
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    message: redactStudioText(entry.message),
    ...(entry.level === undefined ? {} : { level: entry.level }),
    ...(entry.node_id === undefined ? {} : { node_id: entry.node_id }),
    redaction: "best_effort"
  };
}

async function captureSnapshot(
  file: SecureReadonlyFile,
  chunkBytes: number,
  cursorKey: Uint8Array,
  snapshotNonce: string
): Promise<{ readonly content: Buffer; readonly fingerprint: string }> {
  const content = Buffer.allocUnsafe(file.size);
  const fingerprint = createRunLogSnapshotFingerprint(cursorKey, snapshotNonce);
  let position = 0;
  while (position < file.size) {
    const length = Math.min(chunkBytes, file.size - position);
    const read = await file.handle.read(content, position, length, position);
    if (read.bytesRead === 0) {
      throw logError("run_log_changed", "Run log changed while it was being read");
    }
    fingerprint.update(content.subarray(position, position + read.bytesRead));
    position += read.bytesRead;
  }
  const after = await file.handle.stat({ bigint: true });
  if (
    !after.isFile() ||
    after.dev.toString(10) !== file.device ||
    after.ino.toString(10) !== file.inode ||
    after.size !== BigInt(file.size) ||
    after.mtimeNs.toString(10) !== file.modified_nanoseconds ||
    after.ctimeNs.toString(10) !== file.changed_nanoseconds
  ) {
    throw logError("run_log_changed", "Run log changed while it was captured");
  }
  return { content, fingerprint: fingerprint.digest() };
}

function cursorMatchesSnapshot(
  cursor: RunLogCursorEnvelope,
  snapshot: CachedRunLogSnapshot
): boolean {
  const captured = snapshot.cursor;
  return snapshot.content.byteLength === captured.snapshot_bytes &&
    cursor.version === captured.version &&
    cursor.run_id === captured.run_id &&
    cursor.query_hash === captured.query_hash &&
    cursor.snapshot_bytes === captured.snapshot_bytes &&
    cursor.device === captured.device &&
    cursor.inode === captured.inode &&
    cursor.modified_nanoseconds === captured.modified_nanoseconds &&
    cursor.snapshot_nonce === captured.snapshot_nonce &&
    cursor.snapshot_fingerprint === captured.snapshot_fingerprint &&
    cursor.as_of === captured.as_of &&
    cursor.issued_at_ms === captured.issued_at_ms;
}

export function createFilesystemRunLogReader(
  options: FilesystemRunLogReaderOptions
): RunLogReaderPort {
  const maxLineBytes = positiveSafeInteger(
    options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
    "maxLineBytes",
    1024 * 1024
  );
  const maxSnapshotBytes = positiveSafeInteger(
    options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES,
    "maxSnapshotBytes",
    1024 * 1024 * 1024
  );
  const maxScanBytes = positiveSafeInteger(
    options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES,
    "maxScanBytes",
    64 * 1024 * 1024
  );
  const readChunkBytes = positiveSafeInteger(
    options.readChunkBytes ?? DEFAULT_READ_CHUNK_BYTES,
    "readChunkBytes",
    1024 * 1024
  );
  const cursorTtlMs = positiveSafeInteger(
    options.cursorTtlMs ?? DEFAULT_CURSOR_TTL_MS,
    "cursorTtlMs"
  );
  const maxSnapshotCacheEntries = positiveSafeInteger(
    options.maxSnapshotCacheEntries ?? DEFAULT_MAX_SNAPSHOT_CACHE_ENTRIES,
    "maxSnapshotCacheEntries",
    1_024
  );
  const maxSnapshotCacheBytes = positiveSafeInteger(
    options.maxSnapshotCacheBytes ?? maxSnapshotBytes,
    "maxSnapshotCacheBytes",
    1024 * 1024 * 1024
  );
  const snapshotCacheTtlMs = positiveSafeInteger(
    options.snapshotCacheTtlMs ?? cursorTtlMs,
    "snapshotCacheTtlMs"
  );
  const now = options.now ?? (() => new Date());
  const cursorKey = Buffer.from(options.cursorKey ?? createRunLogCursorKey());
  const cursors = createRunLogCursorCodec({
    key: cursorKey,
    ttlMs: cursorTtlMs,
    now
  });
  const snapshots = new RunLogSnapshotCache({
    maxEntries: maxSnapshotCacheEntries,
    maxBytes: maxSnapshotCacheBytes,
    now
  });

  async function openLog(runId: string): Promise<SecureReadonlyFile> {
    return await openSecureRegularFile(options.root, [runId, "runtime.log.jsonl"]);
  }

  async function initialSnapshot(
    runId: string,
    queryHash: string,
    file: SecureReadonlyFile
  ): Promise<CachedRunLogSnapshot> {
    const snapshotNonce = createRunLogSnapshotNonce();
    const captured = await captureSnapshot(
      file,
      readChunkBytes,
      cursorKey,
      snapshotNonce
    );
    const timestamp = now();
    const cursor: RunLogCursorEnvelope = {
      version: 2,
      run_id: runId,
      query_hash: queryHash,
      byte_offset: 0,
      snapshot_bytes: file.size,
      device: file.device,
      inode: file.inode,
      modified_nanoseconds: file.modified_nanoseconds,
      snapshot_nonce: snapshotNonce,
      snapshot_fingerprint: captured.fingerprint,
      last_sequence: 0,
      as_of: timestamp.toISOString(),
      issued_at_ms: timestamp.getTime()
    };
    return {
      cursor,
      content: captured.content,
      expiresAtMs: Math.min(
        Number.MAX_SAFE_INTEGER,
        timestamp.getTime() + Math.min(cursorTtlMs, snapshotCacheTtlMs)
      )
    };
  }

  return {
    async list(rawQuery): Promise<RunLogPage> {
      const parsedQuery = RunLogListQuerySchema.safeParse(rawQuery);
      if (!parsedQuery.success) {
        throw logError("run_log_input_invalid", "Run log query is invalid");
      }
      const query = parsedQuery.data;
      const queryHash = runLogQueryHash(queryIdentity(query));
      let file: SecureReadonlyFile | undefined;

      try {
        let cursor: RunLogCursorEnvelope;
        let snapshot: CachedRunLogSnapshot;
        const isInitialRequest = query.cursor === undefined;
        if (query.cursor === undefined) {
          try {
            file = await openLog(query.run_id);
          } catch (cause) {
            if (cause instanceof SecureReadFileError && cause.code === "missing") {
              const timestamp = now().toISOString();
              return {
                run_id: query.run_id,
                items: [],
                next_cursor: null,
                as_of: timestamp,
                snapshot_bytes: 0,
                scanned_bytes: 0,
                redaction: "best_effort"
              };
            }
            throw cause;
          }
          if (file.size > maxSnapshotBytes) {
            throw logError(
              "run_log_snapshot_too_large",
              "Run log exceeds the configured snapshot limit",
              { max_snapshot_bytes: maxSnapshotBytes }
            );
          }
          if (file.size > maxSnapshotCacheBytes) {
            throw logError(
              "run_log_snapshot_too_large",
              "Run log exceeds the configured snapshot cache limit",
              { max_snapshot_cache_bytes: maxSnapshotCacheBytes }
            );
          }
          snapshot = await initialSnapshot(query.run_id, queryHash, file);
          cursor = snapshot.cursor;
        } else {
          cursor = cursors.decode(query.cursor);
          if (cursor.run_id !== query.run_id || cursor.query_hash !== queryHash) {
            throw logError(
              "run_log_cursor_invalid",
              "Log cursor does not belong to this query"
            );
          }
          const cached = snapshots.get(cursor.snapshot_nonce);
          if (cached === undefined) {
            throw logError(
              "run_log_cursor_expired",
              "Log cursor snapshot has expired"
            );
          }
          if (!cursorMatchesSnapshot(cursor, cached)) {
            throw logError(
              "run_log_cursor_invalid",
              "Log cursor snapshot is invalid"
            );
          }
          snapshot = cached;
        }
        const items: StudioRunLogEntry[] = [];
        const startOffset = cursor.byte_offset;
        let nextOffset = startOffset;
        let lastSequence = cursor.last_sequence;
        for (const line of scanLines({
          content: snapshot.content,
          start: startOffset,
          end: cursor.snapshot_bytes,
          maxLineBytes
        })) {
          nextOffset = line.nextOffset;
          if (line.content.byteLength > 0) {
            const entry = parseStoredLine(line.content, query.run_id, maxLineBytes);
            if (entry.sequence <= lastSequence) {
              throw logError(
                "run_log_store_corrupt",
                "Run log sequence is not strictly increasing"
              );
            }
            lastSequence = entry.sequence;
            if (matchesFilters(entry, query)) {
              items.push(publicEntry(entry));
            }
          }
          if (
            items.length >= query.limit ||
            nextOffset - startOffset >= maxScanBytes
          ) {
            break;
          }
        }

        const hasMore = nextOffset < cursor.snapshot_bytes;
        if (isInitialRequest && hasMore) {
          snapshots.set(snapshot);
        }
        const nextCursor = hasMore
          ? cursors.encode({
              ...cursor,
              byte_offset: nextOffset,
              last_sequence: lastSequence
            })
          : null;
        return RunLogPageSchema.parse({
          run_id: query.run_id,
          items,
          next_cursor: nextCursor,
          as_of: cursor.as_of,
          snapshot_bytes: cursor.snapshot_bytes,
          scanned_bytes: nextOffset - startOffset,
          redaction: "best_effort"
        });
      } catch (cause) {
        if (cause instanceof RunLogReaderError) {
          throw cause;
        }
        if (cause instanceof SecureReadFileError) {
          throw mapSecureReadError(cause);
        }
        throw logError("run_log_io_failed", "Run logs could not be read");
      } finally {
        await file?.handle.close().catch(() => undefined);
      }
    }
  };
}
