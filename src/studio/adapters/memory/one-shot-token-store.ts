import { randomBytes } from "node:crypto";
import { canonicalJson } from "../../../core/workflow/definition-digests.js";
import { studioSecretDigest } from "../../application/confirmations/digests.js";

const DEFAULT_MAX_ENTRIES = 1_024;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_TOKEN_ATTEMPTS = 8;

export type MemoryOneShotTokenRecord<TBinding> = {
  readonly tokenDigest: string;
  readonly expiresAt: number;
  readonly binding: TBinding;
};

type StoredRecord<TBinding> = MemoryOneShotTokenRecord<TBinding> & {
  readonly storedBytes: number;
};

export type MemoryOneShotTokenStoreOptions = {
  readonly subject: string;
  readonly createError: (message: string, cause?: unknown) => Error;
  readonly parseToken: (token: string) => string | undefined;
  readonly now?: () => number;
  readonly createToken?: () => string;
  readonly maxEntries?: number;
  readonly maxTotalBytes?: number;
};

/**
 * Process-local, bounded storage for opaque one-shot authorities.
 *
 * All lifecycle mechanics live here: secure generation, validation, digesting,
 * TTL handling, pruning, canonical byte accounting, defensive cloning, reads,
 * and atomic consume-on-match behavior.
 */
export class MemoryOneShotTokenStore<TBinding> {
  readonly #records = new Map<string, StoredRecord<TBinding>>();
  readonly #subject: string;
  readonly #createError: (message: string, cause?: unknown) => Error;
  readonly #parseToken: (token: string) => string | undefined;
  readonly #now: () => number;
  readonly #createToken: () => string;
  readonly #maxEntries: number;
  readonly #maxTotalBytes: number;
  #totalBytes = 0;

  constructor(options: MemoryOneShotTokenStoreOptions) {
    this.#subject = options.subject;
    this.#createError = options.createError;
    this.#parseToken = options.parseToken;
    this.#now = options.now ?? Date.now;
    this.#createToken = options.createToken ?? (() =>
      randomBytes(32).toString("base64url")
    );
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#maxTotalBytes =
      options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1) {
      this.#fail("capacity must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(this.#maxTotalBytes) ||
      this.#maxTotalBytes < 1
    ) {
      this.#fail("byte capacity must be a positive safe integer");
    }
  }

  async issue(
    binding: TBinding,
    options: { readonly ttlMs: number }
  ): Promise<{ readonly token: string; readonly expiresAt: number }> {
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1) {
      this.#fail("TTL must be a positive safe integer");
    }

    const now = this.#currentTime();
    this.#prune(now);
    if (this.#records.size >= this.#maxEntries) {
      this.#fail("capacity is exhausted");
    }

    const expiresAt = now + options.ttlMs;
    if (!Number.isSafeInteger(expiresAt)) {
      this.#fail("expiry exceeds the safe clock range");
    }
    const storedBinding = this.#clone(binding);

    for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt += 1) {
      const token = this.#parseToken(this.#createToken());
      if (token === undefined) {
        this.#fail("token generator returned an invalid token");
      }
      const tokenDigest = studioSecretDigest(token);
      if (this.#records.has(tokenDigest)) {
        continue;
      }
      const record = {
        tokenDigest,
        expiresAt,
        binding: storedBinding
      } satisfies MemoryOneShotTokenRecord<TBinding>;
      const storedBytes = this.#measure(record);
      if (storedBytes > this.#maxTotalBytes - this.#totalBytes) {
        this.#fail("byte capacity is exhausted");
      }
      this.#records.set(tokenDigest, { ...record, storedBytes });
      this.#totalBytes += storedBytes;
      return { token, expiresAt };
    }

    this.#fail("token generator produced repeated collisions");
  }

  async read(token: string): Promise<MemoryOneShotTokenRecord<TBinding> | undefined> {
    const record = this.#find(token);
    return record === undefined ? undefined : this.#publicRecord(record);
  }

  async consume(
    token: string,
    matches: (binding: TBinding) => boolean = () => true
  ): Promise<MemoryOneShotTokenRecord<TBinding> | undefined> {
    const record = this.#find(token);
    if (record === undefined || !matches(this.#clone(record.binding))) {
      return undefined;
    }
    this.#delete(record.tokenDigest, record);
    return this.#publicRecord(record);
  }

  #find(token: string): StoredRecord<TBinding> | undefined {
    const now = this.#currentTime();
    this.#prune(now);
    const parsedToken = this.#parseToken(token);
    if (parsedToken === undefined) {
      return undefined;
    }
    return this.#records.get(studioSecretDigest(parsedToken));
  }

  #currentTime(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      this.#fail("clock must return a non-negative safe integer");
    }
    return value;
  }

  #prune(now: number): void {
    for (const [digest, record] of this.#records) {
      if (record.expiresAt <= now) {
        this.#delete(digest, record);
      }
    }
  }

  #delete(digest: string, record: StoredRecord<TBinding>): void {
    if (this.#records.delete(digest)) {
      this.#totalBytes -= record.storedBytes;
    }
  }

  #publicRecord(
    record: StoredRecord<TBinding>
  ): MemoryOneShotTokenRecord<TBinding> {
    return {
      tokenDigest: record.tokenDigest,
      expiresAt: record.expiresAt,
      binding: this.#clone(record.binding)
    };
  }

  #clone(binding: TBinding): TBinding {
    try {
      return structuredClone(binding);
    } catch (cause) {
      this.#fail("binding cannot be retained safely", cause);
    }
  }

  #measure(record: MemoryOneShotTokenRecord<TBinding>): number {
    try {
      return Buffer.byteLength(canonicalJson(record), "utf8");
    } catch (cause) {
      this.#fail("binding cannot be measured safely", cause);
    }
  }

  #fail(message: string, cause?: unknown): never {
    throw this.#createError(`${this.#subject} ${message}`, cause);
  }
}
