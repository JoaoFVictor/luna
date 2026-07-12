import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../../core/workflow/definition-digests.js";
import { RunOpaqueIdSchema } from "../../contracts/runs.js";
import { runStoreError } from "../../application/runs/errors.js";

const CursorEnvelopeSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["events", "catalog"]),
    generation: z.string().regex(/^[A-Za-z0-9_-]{24}$/),
    query_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    direction: z.enum(["asc", "desc"]),
    snapshot: z.number().int().safe().nonnegative(),
    as_of: z.string().datetime({ offset: true }),
    run_id: RunOpaqueIdSchema.optional(),
    last_sequence: z.number().int().safe().positive().optional(),
    last_event_id: RunOpaqueIdSchema.optional(),
    last_created_at: z.string().datetime({ offset: true }).optional(),
    last_run_id: RunOpaqueIdSchema.optional()
  })
  .strict()
  .superRefine((cursor, context) => {
    if (cursor.kind === "events") {
      if (cursor.run_id === undefined || cursor.last_sequence === undefined ||
        cursor.last_event_id === undefined ||
        cursor.last_created_at !== undefined || cursor.last_run_id !== undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid event cursor" });
      }
    } else if (cursor.last_created_at === undefined || cursor.last_run_id === undefined ||
      cursor.run_id !== undefined || cursor.last_sequence !== undefined ||
      cursor.last_event_id !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid catalog cursor" });
    }
  });

export type RunCursor = z.infer<typeof CursorEnvelopeSchema>;

function signature(secret: Buffer, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

export function cursorQueryHash(value: unknown): string {
  return sha256Digest(value);
}

export function encodeRunCursor(cursor: RunCursor, secretHex: string): string {
  const parsed = CursorEnvelopeSchema.parse(cursor);
  const payload = Buffer.from(canonicalJson(parsed), "utf8").toString("base64url");
  const mac = signature(Buffer.from(secretHex, "hex"), payload).toString("base64url");
  return `v1.${payload}.${mac}`;
}

export function decodeRunCursor(value: string, secretHex: string): RunCursor {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw runStoreError("run_cursor_invalid", "Run cursor is malformed");
  }
  const [, payload, encodedMac] = parts;
  if (payload === undefined || encodedMac === undefined ||
    !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(encodedMac)) {
    throw runStoreError("run_cursor_invalid", "Run cursor is malformed");
  }

  let supplied: Buffer;
  try {
    supplied = Buffer.from(encodedMac, "base64url");
  } catch {
    throw runStoreError("run_cursor_invalid", "Run cursor is malformed");
  }
  if (supplied.toString("base64url") !== encodedMac) {
    throw runStoreError("run_cursor_tampered", "Run cursor signature is non-canonical");
  }
  const expected = signature(Buffer.from(secretHex, "hex"), payload);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw runStoreError("run_cursor_tampered", "Run cursor signature is invalid");
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    const parsed = CursorEnvelopeSchema.safeParse(decoded);
    if (!parsed.success) {
      throw runStoreError("run_cursor_invalid", "Run cursor payload is invalid");
    }
    return parsed.data;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause) {
      throw cause;
    }
    throw runStoreError("run_cursor_invalid", "Run cursor payload is invalid");
  }
}

export function assertCursorBinding(
  cursor: RunCursor,
  expected: {
    kind: "events" | "catalog";
    generation: string;
    queryHash: string;
    direction: "asc" | "desc";
  }
): void {
  if (cursor.kind !== expected.kind || cursor.generation !== expected.generation ||
    cursor.query_hash !== expected.queryHash || cursor.direction !== expected.direction) {
    throw runStoreError(
      "run_cursor_invalid",
      "Run cursor does not belong to this query"
    );
  }
}
