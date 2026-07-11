import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../../core/workflow/definition-digests.js";
import { RunOpaqueIdSchema } from "../../contracts/runs.js";
import { RunLogReaderError } from "../../application/runs/log-ports.js";

const CURSOR_DOMAIN = "luna-studio:run-log-cursor:v2\0";
const CURSOR_KEY_DERIVATION_DOMAIN = "luna-studio:run-log-key-derivation:v1\0";
const SNAPSHOT_FINGERPRINT_DOMAIN =
  "luna-studio:run-log-snapshot-fingerprint:v1\0";
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const SnapshotFingerprintSchema = z
  .string()
  .regex(/^hmac-sha256:[a-f0-9]{64}$/);
const SnapshotNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

const RunLogCursorEnvelopeSchema = z
  .object({
    version: z.literal(2),
    run_id: RunOpaqueIdSchema,
    query_hash: DigestSchema,
    byte_offset: z.number().int().safe().nonnegative(),
    snapshot_bytes: z.number().int().safe().nonnegative(),
    device: z.string().regex(/^[0-9]+$/),
    inode: z.string().regex(/^[0-9]+$/),
    modified_nanoseconds: z.string().regex(/^[0-9]+$/),
    snapshot_nonce: SnapshotNonceSchema,
    snapshot_fingerprint: SnapshotFingerprintSchema,
    last_sequence: z.number().int().safe().nonnegative(),
    as_of: z.string().datetime({ offset: true }),
    issued_at_ms: z.number().int().safe().nonnegative()
  })
  .strict()
  .refine((cursor) => cursor.byte_offset <= cursor.snapshot_bytes, {
    path: ["byte_offset"],
    message: "Cursor offset exceeds its snapshot"
  });

export type RunLogCursorEnvelope = z.infer<typeof RunLogCursorEnvelopeSchema>;

export type RunLogCursorCodec = {
  readonly encode: (cursor: RunLogCursorEnvelope) => string;
  readonly decode: (value: string) => RunLogCursorEnvelope;
};

function cursorError(
  code:
    | "run_log_cursor_expired"
    | "run_log_cursor_invalid"
    | "run_log_cursor_tampered",
  message: string
): RunLogReaderError {
  return new RunLogReaderError(code, message);
}

function signature(secret: Buffer, payload: string): Buffer {
  return createHmac("sha256", secret)
    .update(CURSOR_DOMAIN, "utf8")
    .update(payload, "ascii")
    .digest();
}

function cursorRootKey(input: Uint8Array): Buffer {
  const key = Buffer.from(input);
  if (key.byteLength < 32) {
    throw new Error("Run log cursor key must contain at least 32 bytes");
  }
  return key;
}

function deriveKey(rootKey: Buffer, purpose: "signature" | "snapshot"): Buffer {
  return createHmac("sha256", rootKey)
    .update(CURSOR_KEY_DERIVATION_DOMAIN, "utf8")
    .update(purpose, "ascii")
    .digest();
}

export function createRunLogSnapshotFingerprint(
  key: Uint8Array,
  nonce: string
): {
  readonly update: (content: Uint8Array) => void;
  readonly digest: () => string;
} {
  const fingerprint = createHmac(
    "sha256",
    deriveKey(cursorRootKey(key), "snapshot")
  )
    .update(SNAPSHOT_FINGERPRINT_DOMAIN, "utf8")
    .update(SnapshotNonceSchema.parse(nonce), "ascii");
  return {
    update(content) {
      fingerprint.update(content);
    },
    digest() {
      return `hmac-sha256:${fingerprint.digest("hex")}`;
    }
  };
}

export function runLogQueryHash(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

export function createRunLogCursorKey(): Buffer {
  return randomBytes(32);
}

export function createRunLogSnapshotNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function createRunLogCursorCodec(options: {
  readonly key?: Uint8Array;
  readonly now?: () => Date;
  readonly ttlMs?: number;
} = {}): RunLogCursorCodec {
  const key = deriveKey(
    cursorRootKey(options.key ?? createRunLogCursorKey()),
    "signature"
  );
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? 15 * 60 * 1_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new Error("Run log cursor TTL must be a positive safe integer");
  }

  return {
    encode(input) {
      const cursor = RunLogCursorEnvelopeSchema.parse(input);
      const payload = Buffer.from(canonicalJson(cursor), "utf8").toString("base64url");
      const mac = signature(key, payload).toString("base64url");
      return `lc2.${payload}.${mac}`;
    },

    decode(value) {
      if (value.length > 4_096) {
        throw cursorError("run_log_cursor_invalid", "Log cursor is malformed");
      }
      const parts = value.split(".");
      if (parts.length !== 3 || parts[0] !== "lc2") {
        throw cursorError("run_log_cursor_invalid", "Log cursor is malformed");
      }
      const payload = parts[1];
      const encodedMac = parts[2];
      if (
        payload === undefined ||
        encodedMac === undefined ||
        !/^[A-Za-z0-9_-]+$/.test(payload) ||
        !/^[A-Za-z0-9_-]+$/.test(encodedMac)
      ) {
        throw cursorError("run_log_cursor_invalid", "Log cursor is malformed");
      }

      const supplied = Buffer.from(encodedMac, "base64url");
      if (supplied.toString("base64url") !== encodedMac) {
        throw cursorError(
          "run_log_cursor_tampered",
          "Log cursor signature is non-canonical"
        );
      }
      const expected = signature(key, payload);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw cursorError("run_log_cursor_tampered", "Log cursor signature is invalid");
      }

      let decoded: unknown;
      try {
        const bytes = Buffer.from(payload, "base64url");
        if (bytes.toString("base64url") !== payload) {
          throw cursorError(
            "run_log_cursor_tampered",
            "Log cursor payload is non-canonical"
          );
        }
        decoded = JSON.parse(bytes.toString("utf8")) as unknown;
      } catch (cause) {
        if (cause instanceof RunLogReaderError) {
          throw cause;
        }
        throw cursorError("run_log_cursor_invalid", "Log cursor payload is invalid");
      }

      const parsed = RunLogCursorEnvelopeSchema.safeParse(decoded);
      if (!parsed.success) {
        throw cursorError("run_log_cursor_invalid", "Log cursor payload is invalid");
      }
      const current = now().getTime();
      if (
        parsed.data.issued_at_ms > current + 60_000 ||
        current - parsed.data.issued_at_ms > ttlMs
      ) {
        throw cursorError("run_log_cursor_expired", "Log cursor has expired");
      }
      return parsed.data;
    }
  };
}
