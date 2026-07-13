import { z } from "zod";
import type { InterruptRecord } from "./contracts.js";

const InterruptPageCursorEnvelopeSchema = z.object({
  version: z.literal(1),
  run_id: z.string().min(1).max(512),
  created_at: z.string().datetime({ offset: true }),
  interrupt_id: z.string().min(1).max(512)
}).strict();

export type InterruptPageCursorEnvelope = z.infer<
  typeof InterruptPageCursorEnvelopeSchema
>;

export class InterruptPageCursorError extends Error {
  readonly code = "interrupt_page_cursor_invalid" as const;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "InterruptPageCursorError";
  }
}

export function compareInterruptRecordsNewestFirst(
  left: Pick<InterruptRecord, "id" | "created_at">,
  right: Pick<InterruptRecord, "id" | "created_at">
): number {
  return right.created_at.localeCompare(left.created_at) ||
    right.id.localeCompare(left.id);
}

export function encodeInterruptPageCursor(
  runId: string,
  record: Pick<InterruptRecord, "id" | "created_at">
): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    run_id: runId,
    created_at: record.created_at,
    interrupt_id: record.id
  } satisfies InterruptPageCursorEnvelope), "utf8").toString("base64url");
}

export function decodeInterruptPageCursor(
  runId: string,
  value: string
): InterruptPageCursorEnvelope {
  try {
    if (value.length > 4_096) throw new Error("cursor_too_large");
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("cursor_non_canonical");
    const parsed = InterruptPageCursorEnvelopeSchema.parse(
      JSON.parse(bytes.toString("utf8")) as unknown
    );
    if (parsed.run_id !== runId) throw new Error("cursor_run_mismatch");
    return parsed;
  } catch (cause) {
    throw new InterruptPageCursorError("Interrupt page cursor is invalid", { cause });
  }
}

export function interruptPageStartIndex(
  records: readonly Pick<InterruptRecord, "id" | "created_at">[],
  cursor: InterruptPageCursorEnvelope | undefined
): number {
  if (cursor === undefined) return 0;
  const index = records.findIndex((record) =>
    record.id === cursor.interrupt_id && record.created_at === cursor.created_at
  );
  if (index < 0) {
    throw new InterruptPageCursorError("Interrupt page cursor is stale");
  }
  return index + 1;
}
