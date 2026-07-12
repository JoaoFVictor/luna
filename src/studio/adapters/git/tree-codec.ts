import { StudioGitRevisionIdSchema } from "../../contracts/resource-history.js";
import { StudioResourceHistoryError } from "../../application/history/errors.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const TREE_ENTRY_PATTERN =
  /^(\d{6}) ([a-z]+) ([a-f0-9]{40}|[a-f0-9]{64}) +(-|\d+)\t(.+)$/u;
const BATCH_HEADER_PATTERN =
  /^([a-f0-9]{40}|[a-f0-9]{64}) ([a-z]+) (\d+)$/u;

export type StudioGitTreeEntry = {
  readonly mode: string;
  readonly type: string;
  readonly objectId: string;
  readonly size: number | null;
  readonly path: string;
};

function invalidGitData(message: string): StudioResourceHistoryError {
  return new StudioResourceHistoryError(
    "studio_history_resource_invalid",
    message
  );
}

export function parseStudioGitTree(
  output: Uint8Array,
  options: { readonly maxEntries: number }
): readonly StudioGitTreeEntry[] {
  let text: string;
  try {
    text = UTF8_DECODER.decode(output);
  } catch (cause) {
    throw new StudioResourceHistoryError(
      "studio_history_resource_invalid",
      "Git tree paths are not valid UTF-8",
      { cause }
    );
  }
  const records = text === "" ? [] : text.split("\0");
  if (records.at(-1) === "") {
    records.pop();
  }
  if (records.length > options.maxEntries) {
    throw new StudioResourceHistoryError(
      "studio_history_source_too_large",
      "The historical entity contains too many Git entries",
      {
        details: {
          actualFiles: records.length,
          maxFiles: options.maxEntries
        }
      }
    );
  }
  return records.map((record) => {
    const match = TREE_ENTRY_PATTERN.exec(record);
    if (match === null) {
      throw invalidGitData("Git returned invalid tree metadata");
    }
    const [, mode, type, objectId, rawSize, entryPath] = match;
    if (
      mode === undefined ||
      type === undefined ||
      objectId === undefined ||
      rawSize === undefined ||
      entryPath === undefined ||
      !StudioGitRevisionIdSchema.safeParse(objectId).success
    ) {
      throw invalidGitData("Git returned incomplete tree metadata");
    }
    const size = rawSize === "-" ? null : Number(rawSize);
    if (size !== null && (!Number.isSafeInteger(size) || size < 0)) {
      throw invalidGitData("Git returned an invalid blob size");
    }
    return { mode, type, objectId, size, path: entryPath };
  });
}

function newlineAt(buffer: Uint8Array, offset: number): number {
  return buffer.indexOf(0x0a, offset);
}

export function parseStudioGitBatch(
  output: Uint8Array,
  expected: readonly Pick<StudioGitTreeEntry, "objectId" | "size">[]
): ReadonlyMap<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  for (const entry of expected) {
    const headerEnd = newlineAt(output, offset);
    if (headerEnd < 0) {
      throw invalidGitData("Git returned a truncated object batch header");
    }
    let header: string;
    try {
      header = UTF8_DECODER.decode(output.subarray(offset, headerEnd));
    } catch (cause) {
      throw new StudioResourceHistoryError(
        "studio_history_resource_invalid",
        "Git returned a non-text object batch header",
        { cause }
      );
    }
    const match = BATCH_HEADER_PATTERN.exec(header);
    if (match === null) {
      throw invalidGitData("Git returned invalid object batch metadata");
    }
    const [, objectId, type, rawSize] = match;
    const size = Number(rawSize);
    if (
      objectId !== entry.objectId ||
      type !== "blob" ||
      entry.size !== size ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      throw invalidGitData("Git object batch does not match tree metadata");
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= output.byteLength || output[contentEnd] !== 0x0a) {
      throw invalidGitData("Git returned a truncated object batch payload");
    }
    const content = Buffer.from(output.subarray(contentStart, contentEnd));
    const previous = blobs.get(objectId);
    if (previous !== undefined && !previous.equals(content)) {
      throw invalidGitData("Git returned inconsistent duplicate objects");
    }
    blobs.set(objectId, content);
    offset = contentEnd + 1;
  }
  if (offset !== output.byteLength) {
    throw invalidGitData("Git returned unexpected object batch bytes");
  }
  return blobs;
}
