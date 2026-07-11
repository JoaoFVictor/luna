import {
  StudioDraftPersistenceError,
  type StudioDraftListInput
} from "../../application/drafts/persistence.js";
import type {
  StudioDraftListDiagnostic,
  StudioDraftListPage,
  StudioDraftSummary
} from "../../contracts/drafts.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_BYTES = 1_024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function decodeCursor(cursor: string): string {
  try {
    if (Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES) {
      throw new Error("cursor too large");
    }
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) {
      throw new Error("cursor is not canonical base64url");
    }
    const directoryName = UTF8_DECODER.decode(bytes);
    if (
      directoryName === "" ||
      directoryName.includes("/") ||
      directoryName.includes("\\") ||
      directoryName.includes("\0")
    ) {
      throw new Error("cursor directory is invalid");
    }
    return directoryName;
  } catch (cause) {
    throw new StudioDraftPersistenceError(
      "studio_list_cursor_invalid",
      "Studio draft list cursor is invalid",
      { cause }
    );
  }
}

function encodeCursor(directoryName: string): string {
  return Buffer.from(directoryName, "utf8").toString("base64url");
}

function pageSize(input: StudioDraftListInput): number {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new StudioDraftPersistenceError(
      "studio_list_limit_invalid",
      `Studio draft page size must be between 1 and ${MAX_PAGE_SIZE}`
    );
  }
  return limit;
}

export type ParsedStudioDraftListQuery = {
  readonly limit: number;
  readonly after?: string;
};

export function parseStudioDraftListQuery(
  input: StudioDraftListInput
): ParsedStudioDraftListQuery {
  return {
    limit: pageSize(input),
    ...(input.cursor === undefined ? {} : { after: decodeCursor(input.cursor) })
  };
}

export type StudioDraftListEntry =
  | { readonly kind: "summary"; readonly value: StudioDraftSummary }
  | {
      readonly kind: "diagnostic";
      readonly value: StudioDraftListDiagnostic;
    };

export async function buildStudioDraftListPage(input: {
  readonly directoryNames: readonly string[];
  readonly hasMore: boolean;
  readonly readEntry: (directoryName: string) => Promise<StudioDraftListEntry>;
}): Promise<StudioDraftListPage> {
  const entries: StudioDraftListEntry[] = [];
  // Deliberately sequential: aggregate memory stays within one metadata limit.
  for (const directoryName of input.directoryNames) {
    entries.push(await input.readEntry(directoryName));
  }
  return {
    items: entries
      .filter((entry) => entry.kind === "summary")
      .map((entry) => entry.value),
    diagnostics: entries
      .filter((entry) => entry.kind === "diagnostic")
      .map((entry) => entry.value),
    next_cursor:
      input.hasMore && input.directoryNames.length > 0
        ? encodeCursor(input.directoryNames.at(-1)!)
        : null
  };
}
