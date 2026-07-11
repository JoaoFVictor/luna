import type { Dirent } from "node:fs";
import { opendir } from "node:fs/promises";
import { StudioDraftPersistenceError } from "../../application/drafts/persistence.js";
import type { StudioStorageLayout } from "./private-storage-layout.js";
import { storageError } from "./private-storage-errors.js";

function insertBoundedName(
  names: string[],
  name: string,
  capacity: number
): void {
  const insertionIndex = names.findIndex((candidate) => candidate > name);
  names.splice(insertionIndex === -1 ? names.length : insertionIndex, 0, name);
  if (names.length > capacity) {
    names.pop();
  }
}

export async function selectStudioDraftDirectoryNames(input: {
  readonly layout: StudioStorageLayout;
  readonly after?: string;
  readonly limit: number;
  readonly maxEntries: number;
}): Promise<{ readonly names: readonly string[]; readonly hasMore: boolean }> {
  try {
    const selected: string[] = [];
    let actualEntries = 0;
    const directory = await opendir(input.layout.draftsRoot);
    for await (const entry of directory) {
      actualEntries += 1;
      if (actualEntries > input.maxEntries) {
        throw new StudioDraftPersistenceError(
          "studio_storage_quota_exceeded",
          "Studio draft storage contains too many directory entries",
          {
            details: {
              actualEntries,
              maxEntries: input.maxEntries
            }
          }
        );
      }
      if (
        entry.name.startsWith(".") ||
        (input.after !== undefined && entry.name <= input.after)
      ) {
        continue;
      }
      insertBoundedName(selected, entry.name, input.limit + 1);
    }
    return {
      names: selected.slice(0, input.limit),
      hasMore: selected.length > input.limit
    };
  } catch (cause) {
    if (cause instanceof StudioDraftPersistenceError) {
      throw cause;
    }
    throw storageError("Unable to list Studio drafts", cause);
  }
}

export async function readBoundedPrivateDirectoryEntries(
  directoryPath: string,
  maxEntries: number,
  label: string
): Promise<readonly Dirent[]> {
  try {
    const entries: Dirent[] = [];
    const directory = await opendir(directoryPath);
    for await (const entry of directory) {
      entries.push(entry);
      if (entries.length > maxEntries) {
        throw new StudioDraftPersistenceError(
          "studio_storage_quota_exceeded",
          `${label} contains too many entries`,
          {
            details: {
              actualEntries: entries.length,
              maxEntries
            }
          }
        );
      }
    }
    return entries;
  } catch (cause) {
    if (cause instanceof StudioDraftPersistenceError) {
      throw cause;
    }
    throw storageError(`Unable to inspect ${label}`, cause);
  }
}
