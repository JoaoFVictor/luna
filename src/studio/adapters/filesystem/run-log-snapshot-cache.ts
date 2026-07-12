import type { RunLogCursorEnvelope } from "./run-log-cursor.js";

export type CachedRunLogSnapshot = {
  readonly cursor: RunLogCursorEnvelope;
  readonly content: Buffer;
  readonly expiresAtMs: number;
};

export class RunLogSnapshotCache {
  readonly #entries = new Map<string, CachedRunLogSnapshot>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #now: () => Date;
  #storedBytes = 0;

  constructor(options: {
    readonly maxEntries: number;
    readonly maxBytes: number;
    readonly now: () => Date;
  }) {
    this.#maxEntries = options.maxEntries;
    this.#maxBytes = options.maxBytes;
    this.#now = options.now;
  }

  get(snapshotNonce: string): CachedRunLogSnapshot | undefined {
    this.#pruneExpired();
    const entry = this.#entries.get(snapshotNonce);
    if (entry === undefined) {
      return undefined;
    }
    this.#entries.delete(snapshotNonce);
    this.#entries.set(snapshotNonce, entry);
    return entry;
  }

  set(entry: CachedRunLogSnapshot): void {
    if (entry.content.byteLength > this.#maxBytes) {
      throw new Error("Run log snapshot exceeds the cache byte limit");
    }
    this.#pruneExpired();
    this.#delete(entry.cursor.snapshot_nonce);
    this.#entries.set(entry.cursor.snapshot_nonce, entry);
    this.#storedBytes += entry.content.byteLength;
    while (
      this.#entries.size > this.#maxEntries ||
      this.#storedBytes > this.#maxBytes
    ) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) {
        throw new Error("Run log snapshot cache accounting is inconsistent");
      }
      this.#delete(oldest);
    }
  }

  #pruneExpired(): void {
    const current = this.#now().getTime();
    for (const [nonce, entry] of this.#entries) {
      if (entry.expiresAtMs < current) {
        this.#delete(nonce);
      }
    }
  }

  #delete(snapshotNonce: string): void {
    const existing = this.#entries.get(snapshotNonce);
    if (existing === undefined) {
      return;
    }
    this.#entries.delete(snapshotNonce);
    this.#storedBytes -= existing.content.byteLength;
  }
}
