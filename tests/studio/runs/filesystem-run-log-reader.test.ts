import { createHash } from "node:crypto";
import path from "node:path";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createFilesystemRunLogReader } from "../../../src/studio/adapters/filesystem/run-log-reader.js";

const RUN_ID = "run-logs-1";
const CURSOR_KEY = Buffer.alloc(32, 0x52);

type LogInput = {
  readonly sequence: number;
  readonly timestamp?: string;
  readonly message: string;
  readonly level?: "debug" | "info" | "warn" | "error";
  readonly node_id?: string;
};

function line(input: LogInput, runId = RUN_ID): string {
  return `${JSON.stringify({
    run_id: runId,
    sequence: input.sequence,
    timestamp: input.timestamp ?? "2026-07-11T12:00:00.000Z",
    message: input.message,
    ...(input.level === undefined ? {} : { level: input.level }),
    ...(input.node_id === undefined ? {} : { node_id: input.node_id })
  })}\n`;
}

function decodedCursorPayload(cursor: string): Record<string, unknown> {
  const payload = cursor.split(".")[1];
  if (payload === undefined) {
    throw new Error("Expected cursor payload");
  }
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as
    Record<string, unknown>;
}

async function writeRunLogs(
  root: string,
  runId: string,
  entries: readonly LogInput[]
): Promise<void> {
  const logPath = path.join(root, runId, "runtime.log.jsonl");
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(
    logPath,
    entries.map((entry) => line(entry, runId)).join("")
  );
}

async function withLogs(
  operation: (fixture: {
    readonly root: string;
    readonly outside: string;
    readonly logPath: string;
    readonly write: (entries: readonly LogInput[]) => Promise<void>;
    readonly reader: ReturnType<typeof createFilesystemRunLogReader>;
  }) => Promise<void>,
  readerOptions: Partial<Parameters<typeof createFilesystemRunLogReader>[0]> = {}
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-studio-logs-"));
  const outside = await mkdtemp(path.join(tmpdir(), "luna-studio-log-outside-"));
  const logPath = path.join(root, RUN_ID, "runtime.log.jsonl");
  const reader = createFilesystemRunLogReader({
    root,
    cursorKey: CURSOR_KEY,
    ...readerOptions
  });
  async function write(entries: readonly LogInput[]): Promise<void> {
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, entries.map((entry) => line(entry)).join(""));
  }
  try {
    await operation({ root, outside, logPath, write, reader });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

describe("filesystem Studio run log reader", () => {
  it("paginates a stable snapshot and redacts messages", async () => {
    await withLogs(async ({ write, logPath, reader }) => {
      await write([
        { sequence: 1, level: "info", message: "start" },
        {
          sequence: 2,
          level: "warn",
          message: "Authorization: Bearer secret-token-value"
        },
        { sequence: 3, level: "error", message: "done" }
      ]);
      const first = await reader.list({ run_id: RUN_ID, limit: 2 });
      expect(first.items).toEqual([
        expect.objectContaining({ sequence: 1, message: "start" }),
        expect.objectContaining({
          sequence: 2,
          message: "Authorization: Bearer [REDACTED]",
          redaction: "best_effort"
        })
      ]);
      expect(first.next_cursor).not.toBeNull();

      await appendFile(logPath, line({ sequence: 4, message: "late append" }));
      const second = await reader.list({
        run_id: RUN_ID,
        limit: 2,
        cursor: first.next_cursor ?? undefined
      });
      expect(second.items.map((entry) => entry.sequence)).toEqual([3]);
      expect(second.next_cursor).toBeNull();
      expect(second.snapshot_bytes).toBe(first.snapshot_bytes);
      expect(second.as_of).toBe(first.as_of);

      const fresh = await reader.list({ run_id: RUN_ID, limit: 10 });
      expect(fresh.items.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);
    });
  });

  it("reads the source only once across every page of a cursor", async () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({
      sequence: index + 1,
      message: `message-${index + 1}`
    }));
    const expectedBytes = Buffer.byteLength(
      entries.map((entry) => line(entry)).join("")
    );
    await withLogs(async ({ write, logPath, reader }) => {
      await write(entries);
      const probe = await open(logPath, "r");
      type ReadMethod = (...args: unknown[]) => Promise<{
        readonly bytesRead: number;
        readonly buffer: unknown;
      }>;
      const prototype = Object.getPrototypeOf(probe) as Record<string, unknown>;
      const originalRead = prototype["read"] as ReadMethod;
      await probe.close();
      let sourceBytesRead = 0;
      let sourceReadCalls = 0;
      prototype["read"] = async function (...args: unknown[]) {
        const result = await originalRead.apply(this, args);
        sourceBytesRead += result.bytesRead;
        sourceReadCalls += 1;
        return result;
      };

      try {
        const sequences: number[] = [];
        let cursor: string | undefined;
        do {
          const page = await reader.list({
            run_id: RUN_ID,
            limit: 1,
            ...(cursor === undefined ? {} : { cursor })
          });
          sequences.push(...page.items.map((entry) => entry.sequence));
          cursor = page.next_cursor ?? undefined;
        } while (cursor !== undefined);

        expect(sequences).toEqual(entries.map((entry) => entry.sequence));
        expect(sourceBytesRead).toBe(expectedBytes);
        expect(sourceReadCalls).toBeGreaterThan(1);
      } finally {
        prototype["read"] = originalRead;
      }
    }, { readChunkBytes: 32 });
  });

  it("redacts secret-looking fields in JSON-formatted log messages", async () => {
    await withLogs(async ({ write, reader }) => {
      await write([{
        sequence: 1,
        message: '{"api_token":"secret-value","public_count":2}'
      }]);
      const page = await reader.list({ run_id: RUN_ID });
      expect(page.items[0]?.message).toBe(
        '{"api_token":"[REDACTED]","public_count":2}'
      );
      expect(JSON.stringify(page)).not.toContain("secret-value");
    });
  });

  it("binds signed cursors to filters and detects tampering and expiry", async () => {
    let now = new Date("2026-07-11T12:00:00.000Z");
    await withLogs(async ({ write, reader }) => {
      await write([
        { sequence: 1, level: "info", message: "one" },
        { sequence: 2, level: "error", message: "two" }
      ]);
      const first = await reader.list({
        run_id: RUN_ID,
        levels: ["info"],
        limit: 1
      });
      const cursor = first.next_cursor;
      expect(cursor).not.toBeNull();
      if (cursor === null) {
        throw new Error("Expected log cursor");
      }

      await expect(reader.list({
        run_id: RUN_ID,
        levels: ["error"],
        limit: 1,
        cursor
      })).rejects.toMatchObject({ code: "run_log_cursor_invalid" });

      const replacement = cursor.endsWith("A") ? "B" : "A";
      const tampered = `${cursor.slice(0, -1)}${replacement}`;
      await expect(reader.list({
        run_id: RUN_ID,
        levels: ["info"],
        limit: 1,
        cursor: tampered
      })).rejects.toMatchObject({ code: "run_log_cursor_tampered" });

      now = new Date("2026-07-11T12:16:00.000Z");
      await expect(reader.list({
        run_id: RUN_ID,
        levels: ["info"],
        limit: 1,
        cursor
      })).rejects.toMatchObject({ code: "run_log_cursor_expired" });
    }, { now: () => now });
  });

  it("expires a cursor when its in-process snapshot TTL elapses", async () => {
    let now = new Date("2026-07-11T12:00:00.000Z");
    await withLogs(async ({ write, reader }) => {
      await write([
        { sequence: 1, message: "one" },
        { sequence: 2, message: "two" }
      ]);
      const first = await reader.list({ run_id: RUN_ID, limit: 1 });
      if (first.next_cursor === null) {
        throw new Error("Expected cursor");
      }

      now = new Date("2026-07-11T12:00:00.101Z");
      await expect(reader.list({
        run_id: RUN_ID,
        limit: 1,
        cursor: first.next_cursor
      })).rejects.toMatchObject({ code: "run_log_cursor_expired" });
    }, {
      now: () => now,
      cursorTtlMs: 10_000,
      snapshotCacheTtlMs: 100
    });
  });

  it("expires the least-recent snapshot when the cache entry bound is reached", async () => {
    await withLogs(async ({ root, write, reader }) => {
      const entries = [
        { sequence: 1, message: "one" },
        { sequence: 2, message: "two" }
      ] as const;
      await write(entries);
      const first = await reader.list({ run_id: RUN_ID, limit: 1 });
      if (first.next_cursor === null) {
        throw new Error("Expected first cursor");
      }

      const secondRunId = "run-logs-2";
      await writeRunLogs(root, secondRunId, entries);
      const second = await reader.list({ run_id: secondRunId, limit: 1 });
      if (second.next_cursor === null) {
        throw new Error("Expected second cursor");
      }

      await expect(reader.list({
        run_id: RUN_ID,
        limit: 1,
        cursor: first.next_cursor
      })).rejects.toMatchObject({ code: "run_log_cursor_expired" });
      await expect(reader.list({
        run_id: secondRunId,
        limit: 1,
        cursor: second.next_cursor
      })).resolves.toMatchObject({
        items: [expect.objectContaining({ sequence: 2 })]
      });
    }, { maxSnapshotCacheEntries: 1 });
  });

  it("expires the least-recent snapshot when the cache byte bound is reached", async () => {
    const entries = [
      { sequence: 1, message: "one" },
      { sequence: 2, message: "two" }
    ] as const;
    const oneSnapshotBytes = Buffer.byteLength(
      entries.map((entry) => line(entry)).join("")
    );
    await withLogs(async ({ root, write, reader }) => {
      await write(entries);
      const first = await reader.list({ run_id: RUN_ID, limit: 1 });
      if (first.next_cursor === null) {
        throw new Error("Expected first cursor");
      }

      const secondRunId = "run-logs-2";
      await writeRunLogs(root, secondRunId, entries);
      const second = await reader.list({ run_id: secondRunId, limit: 1 });
      if (second.next_cursor === null) {
        throw new Error("Expected second cursor");
      }

      await expect(reader.list({
        run_id: RUN_ID,
        limit: 1,
        cursor: first.next_cursor
      })).rejects.toMatchObject({ code: "run_log_cursor_expired" });
      await expect(reader.list({
        run_id: secondRunId,
        limit: 1,
        cursor: second.next_cursor
      })).resolves.toMatchObject({
        items: [expect.objectContaining({ sequence: 2 })]
      });
    }, {
      maxSnapshotCacheEntries: 4,
      maxSnapshotCacheBytes: oneSnapshotBytes
    });
  });

  it("uses a keyed snapshot fingerprint instead of exposing a raw log digest", async () => {
    await withLogs(async ({ root, write, reader }) => {
      const entries = [
        { sequence: 1, message: "yes" },
        { sequence: 2, message: "no" }
      ] as const;
      await write(entries);
      const first = await reader.list({ run_id: RUN_ID, limit: 1 });
      if (first.next_cursor === null) {
        throw new Error("Expected cursor");
      }

      const payload = decodedCursorPayload(first.next_cursor);
      const rawDigest = `sha256:${createHash("sha256")
        .update(entries.map((entry) => line(entry)).join(""))
        .digest("hex")}`;
      expect(payload["snapshot_fingerprint"]).toMatch(
        /^hmac-sha256:[a-f0-9]{64}$/
      );
      expect(payload["snapshot_fingerprint"]).not.toBe(rawDigest);
      expect(JSON.stringify(payload)).not.toContain(rawDigest.slice("sha256:".length));

      const sameKey = await reader.list({ run_id: RUN_ID, limit: 1 });
      if (sameKey.next_cursor === null) {
        throw new Error("Expected another cursor");
      }
      const sameKeyPayload = decodedCursorPayload(sameKey.next_cursor);
      expect(sameKeyPayload["snapshot_nonce"]).not.toBe(payload["snapshot_nonce"]);
      expect(sameKeyPayload["snapshot_fingerprint"])
        .not.toBe(payload["snapshot_fingerprint"]);

      const alternateReader = createFilesystemRunLogReader({
        root,
        cursorKey: Buffer.alloc(32, 0x53)
      });
      const alternate = await alternateReader.list({ run_id: RUN_ID, limit: 1 });
      if (alternate.next_cursor === null) {
        throw new Error("Expected alternate cursor");
      }
      expect(decodedCursorPayload(alternate.next_cursor)["snapshot_fingerprint"])
        .not.toBe(payload["snapshot_fingerprint"]);
    });
  });

  it("advances a cursor when a selective filter exhausts the scan budget", async () => {
    await withLogs(async ({ write, reader }) => {
      await write([
        { sequence: 1, level: "debug", message: "x".repeat(80) },
        { sequence: 2, level: "debug", message: "y".repeat(80) },
        { sequence: 3, level: "error", message: "match" }
      ]);
      const first = await reader.list({
        run_id: RUN_ID,
        levels: ["error"],
        limit: 10
      });
      expect(first.items).toEqual([]);
      expect(first.next_cursor).not.toBeNull();
      expect(first.scanned_bytes).toBeGreaterThanOrEqual(100);

      let cursor = first.next_cursor;
      let matches: number[] = [];
      for (let page = 0; page < 4 && cursor !== null; page += 1) {
        const next = await reader.list({
          run_id: RUN_ID,
          levels: ["error"],
          limit: 10,
          cursor
        });
        matches = matches.concat(next.items.map((entry) => entry.sequence));
        cursor = next.next_cursor;
      }
      expect(matches).toEqual([3]);
      expect(cursor).toBeNull();
    }, { maxScanBytes: 100, readChunkBytes: 32 });
  });

  it("keeps cursors immutable after truncation, rotation, or in-place rewrite", async () => {
    await withLogs(async ({ write, logPath, reader }) => {
      await write([
        { sequence: 1, message: "one" },
        { sequence: 2, message: "two" }
      ]);
      const first = await reader.list({ run_id: RUN_ID, limit: 1 });
      if (first.next_cursor === null) {
        throw new Error("Expected cursor");
      }
      await writeFile(logPath, line({ sequence: 1, message: "short" }));
      await expect(reader.list({
        run_id: RUN_ID,
        limit: 1,
        cursor: first.next_cursor
      })).resolves.toMatchObject({
        items: [expect.objectContaining({ sequence: 2, message: "two" })],
        next_cursor: null,
        snapshot_bytes: first.snapshot_bytes
      });
    });

    await withLogs(async ({ write, logPath, reader }) => {
      await write([
        { sequence: 1, message: "one" },
        { sequence: 2, message: "two" }
      ]);
      const first = await reader.list({ run_id: RUN_ID, limit: 1 });
      if (first.next_cursor === null) {
        throw new Error("Expected cursor");
      }
      await rename(logPath, `${logPath}.old`);
      await expect(reader.list({
        run_id: RUN_ID,
        limit: 1,
        cursor: first.next_cursor
      })).resolves.toMatchObject({
        items: [expect.objectContaining({ sequence: 2, message: "two" })],
        next_cursor: null,
        snapshot_bytes: first.snapshot_bytes
      });
    });

    await withLogs(async ({ write, logPath, reader }) => {
      await write([
        { sequence: 1, message: "one" },
        { sequence: 2, message: "two" }
      ]);
      const first = await reader.list({ run_id: RUN_ID, limit: 1 });
      if (first.next_cursor === null) {
        throw new Error("Expected cursor");
      }
      await writeFile(logPath, [
        line({ sequence: 1, message: "eno" }),
        line({ sequence: 2, message: "owt" })
      ].join(""));
      const changedAt = new Date("2030-01-01T00:00:00.000Z");
      await utimes(logPath, changedAt, changedAt);
      await expect(reader.list({
        run_id: RUN_ID,
        limit: 1,
        cursor: first.next_cursor
      })).resolves.toMatchObject({
        items: [expect.objectContaining({ sequence: 2, message: "two" })],
        next_cursor: null,
        snapshot_bytes: first.snapshot_bytes
      });
    });
  });

  it("keeps a snapshot immutable after rewrite plus append on the same inode", async () => {
    await withLogs(async ({ write, logPath, reader }) => {
      await write([
        { sequence: 1, message: "one" },
        { sequence: 2, message: "two" }
      ]);
      const first = await reader.list({ run_id: RUN_ID, limit: 1 });
      if (first.next_cursor === null) {
        throw new Error("Expected cursor");
      }

      await writeFile(logPath, [
        line({ sequence: 1, message: "rewritten-one" }),
        line({ sequence: 2, message: "rewritten-two" }),
        line({ sequence: 3, message: "appended" })
      ].join(""));

      await expect(reader.list({
        run_id: RUN_ID,
        limit: 1,
        cursor: first.next_cursor
      })).resolves.toMatchObject({
        items: [expect.objectContaining({ sequence: 2, message: "two" })],
        next_cursor: null,
        snapshot_bytes: first.snapshot_bytes
      });
    });
  });

  it("fstats the pinned file after reading before returning a page", async () => {
    await withLogs(async ({ write, logPath, reader }) => {
      await write([
        { sequence: 1, message: "one" },
        { sequence: 2, message: "two" }
      ]);

      const probe = await open(logPath, "r");
      type StatMethod = (...args: unknown[]) => Promise<unknown>;
      const prototype = Object.getPrototypeOf(probe) as Record<string, unknown>;
      const originalStat = prototype["stat"] as StatMethod;
      await probe.close();
      let statCalls = 0;
      prototype["stat"] = async function (...args: unknown[]): Promise<unknown> {
        statCalls += 1;
        if (statCalls === 2) {
          await writeFile(logPath, [
            line({ sequence: 1, message: "eno" }),
            line({ sequence: 2, message: "owt" })
          ].join(""));
          const changedAt = new Date("2030-01-01T00:00:00.000Z");
          await utimes(logPath, changedAt, changedAt);
        }
        return await originalStat.apply(this, args);
      };

      try {
        await expect(reader.list({ run_id: RUN_ID, limit: 10 }))
          .rejects.toMatchObject({ code: "run_log_changed" });
        expect(statCalls).toBe(2);
      } finally {
        prototype["stat"] = originalStat;
      }
    });
  });

  it("rejects rewrite plus append performed immediately before the final fstat", async () => {
    await withLogs(async ({ write, logPath, reader }) => {
      await write([
        { sequence: 1, message: "one" },
        { sequence: 2, message: "two" }
      ]);

      const probe = await open(logPath, "r");
      type StatMethod = (...args: unknown[]) => Promise<unknown>;
      const prototype = Object.getPrototypeOf(probe) as Record<string, unknown>;
      const originalStat = prototype["stat"] as StatMethod;
      await probe.close();
      let statCalls = 0;
      prototype["stat"] = async function (...args: unknown[]): Promise<unknown> {
        statCalls += 1;
        if (statCalls === 2) {
          await writeFile(logPath, [
            line({ sequence: 1, message: "rewritten-one" }),
            line({ sequence: 2, message: "rewritten-two" }),
            line({ sequence: 3, message: "appended" })
          ].join(""));
        }
        return await originalStat.apply(this, args);
      };

      try {
        await expect(reader.list({ run_id: RUN_ID, limit: 1 }))
          .rejects.toMatchObject({ code: "run_log_changed" });
        expect(statCalls).toBe(2);
      } finally {
        prototype["stat"] = originalStat;
      }
    });
  });

  it("rejects traversal and symlink escapes without exposing physical paths", async () => {
    await withLogs(async ({ root, outside, reader }) => {
      await expect(reader.list({ run_id: "../outside" })).rejects.toMatchObject({
        code: "run_log_input_invalid"
      });

      const outsideLog = path.join(outside, "runtime.log.jsonl");
      await writeFile(outsideLog, line({ sequence: 1, message: "secret" }));
      await mkdir(path.join(root, RUN_ID), { recursive: true });
      await symlink(outsideLog, path.join(root, RUN_ID, "runtime.log.jsonl"));
      const error = await reader.list({ run_id: RUN_ID }).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code: "run_log_security_violation" });
      expect(String((error as Error).message)).not.toContain(root);
      expect(JSON.stringify(error)).not.toContain(outside);
    });
  });

  it("bounds snapshots and individual lines", async () => {
    await withLogs(async ({ write, reader }) => {
      await write([{ sequence: 1, message: "x".repeat(256) }]);
      await expect(reader.list({ run_id: RUN_ID })).rejects.toMatchObject({
        code: "run_log_snapshot_too_large",
        details: { max_snapshot_bytes: 64 }
      });
    }, { maxSnapshotBytes: 64 });

    await withLogs(async ({ write, reader }) => {
      await write([{ sequence: 1, message: "x".repeat(128) }]);
      await expect(reader.list({ run_id: RUN_ID })).rejects.toMatchObject({
        code: "run_log_line_too_large",
        details: { max_line_bytes: 80 }
      });
    }, { maxLineBytes: 80 });
  });

  it("rejects malformed encoding, JSON, run ids, and non-monotonic sequences", async () => {
    await withLogs(async ({ logPath, reader }) => {
      await mkdir(path.dirname(logPath), { recursive: true });
      await writeFile(logPath, new Uint8Array([0xff, 0x0a]));
      await expect(reader.list({ run_id: RUN_ID })).rejects.toMatchObject({
        code: "run_log_store_corrupt"
      });
    });

    await withLogs(async ({ logPath, reader }) => {
      await mkdir(path.dirname(logPath), { recursive: true });
      await writeFile(logPath, "{not-json}\n");
      await expect(reader.list({ run_id: RUN_ID })).rejects.toMatchObject({
        code: "run_log_store_corrupt"
      });
    });

    await withLogs(async ({ logPath, reader }) => {
      await mkdir(path.dirname(logPath), { recursive: true });
      await writeFile(logPath, line({ sequence: 1, message: "wrong run" }, "other-run"));
      await expect(reader.list({ run_id: RUN_ID })).rejects.toMatchObject({
        code: "run_log_store_corrupt"
      });
    });

    await withLogs(async ({ write, reader }) => {
      await write([
        { sequence: 2, message: "two" },
        { sequence: 1, message: "one" }
      ]);
      await expect(reader.list({ run_id: RUN_ID })).rejects.toMatchObject({
        code: "run_log_store_corrupt"
      });
    });
  });

  it("returns an empty bounded page when a run has no log file", async () => {
    await withLogs(async ({ reader }) => {
      await expect(reader.list({ run_id: RUN_ID })).resolves.toMatchObject({
        run_id: RUN_ID,
        items: [],
        next_cursor: null,
        snapshot_bytes: 0,
        scanned_bytes: 0,
        redaction: "best_effort"
      });
    });
  });
});
