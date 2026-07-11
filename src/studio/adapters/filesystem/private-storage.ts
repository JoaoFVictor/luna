import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  rm
} from "node:fs/promises";
import path from "node:path";
import {
  writeFileAtomically,
  type AtomicWriteFaultStage
} from "../../../core/filesystem/atomic-write.js";
import { StudioDraftPersistenceError } from "../../application/drafts/persistence.js";
import {
  assertStudioPrivateFileSize,
  type StudioPrivateFileLimit
} from "./storage-limits.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const READ_CHUNK_BYTES = 64 * 1024;
const REMOVAL_QUARANTINE_PREFIX = ".removing-";

export type StudioStorageLayout = {
  readonly projectRoot: string;
  readonly studioRoot: string;
  readonly draftsRoot: string;
};

export type StudioPrivateEntryIdentity = {
  readonly device: number;
  readonly inode: number;
  readonly kind: "directory" | "file" | "symbolic_link" | "other";
};

export type StudioPrivateEntryRemovalFaultStage =
  | "after_private_entry_inspected";

export type StudioPrivateEntryRemovalOptions = {
  readonly expectedIdentity?: StudioPrivateEntryIdentity;
  readonly faultInjector?: (
    stage: StudioPrivateEntryRemovalFaultStage
  ) => Promise<void> | void;
};

function storageError(
  message: string,
  cause?: unknown
): StudioDraftPersistenceError {
  return new StudioDraftPersistenceError(
    "studio_storage_io_failed",
    message,
    { cause }
  );
}

function invalidStorage(
  message: string,
  cause?: unknown
): StudioDraftPersistenceError {
  return new StudioDraftPersistenceError("studio_storage_invalid", message, {
    cause
  });
}

function isErrno(cause: unknown, code: string): boolean {
  return (cause as NodeJS.ErrnoException).code === code;
}

export function studioPrivateEntryIdentity(
  metadata: Stats
): StudioPrivateEntryIdentity {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    kind: metadata.isSymbolicLink()
      ? "symbolic_link"
      : metadata.isDirectory()
        ? "directory"
        : metadata.isFile()
          ? "file"
          : "other"
  };
}

function samePrivateEntryIdentity(
  left: StudioPrivateEntryIdentity,
  right: StudioPrivateEntryIdentity
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.kind === right.kind
  );
}

export function isStudioPrivateRemovalName(name: string): boolean {
  return (
    name.startsWith(REMOVAL_QUARANTINE_PREFIX) &&
    /^[a-f0-9]{32}$/u.test(name.slice(REMOVAL_QUARANTINE_PREFIX.length))
  );
}

function removalQuarantinePath(parentPath: string): string {
  return path.join(
    parentPath,
    `${REMOVAL_QUARANTINE_PREFIX}${randomBytes(16).toString("hex")}`
  );
}

export function createStudioStorageLayout(
  projectRoot: string
): StudioStorageLayout {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const studioRoot = path.join(absoluteProjectRoot, ".luna", "studio");

  return {
    projectRoot: absoluteProjectRoot,
    studioRoot,
    draftsRoot: path.join(studioRoot, "drafts")
  };
}

async function assertDirectory(directory: string, label: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(directory);
  } catch (cause) {
    throw storageError(`Unable to inspect ${label}`, cause);
  }

  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw invalidStorage(`${label} must be a real directory`);
  }
}

async function assertExistingDirectory(
  directory: string,
  label: string
): Promise<boolean> {
  let entry;
  try {
    entry = await lstat(directory);
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) {
      return false;
    }
    throw storageError(`Unable to inspect ${label}`, cause);
  }

  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw invalidStorage(`${label} must be a real directory`);
  }
  return true;
}

async function ensureDirectory(
  directory: string,
  label: string,
  enforcePrivateMode: boolean
): Promise<void> {
  let created = false;
  try {
    await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
    created = true;
  } catch (cause) {
    if (!isErrno(cause, "EEXIST")) {
      throw storageError(`Unable to create ${label}`, cause);
    }
  }

  await assertDirectory(directory, label);
  let directoryHandle;
  try {
    directoryHandle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    if (enforcePrivateMode) {
      await directoryHandle.chmod(PRIVATE_DIRECTORY_MODE);
    }
    await directoryHandle.sync();
  } catch (cause) {
    throw storageError(`Unable to secure ${label}`, cause);
  } finally {
    await directoryHandle?.close();
  }
  if (created) {
    await syncPrivateDirectory(
      path.dirname(directory),
      `parent directory for ${label}`
    );
  }
}

export async function syncPrivateDirectory(
  directoryPath: string,
  label = "Studio storage directory"
): Promise<void> {
  let directory;
  try {
    directory = await open(
      directoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const metadata = await directory.stat();
    if (!metadata.isDirectory()) {
      throw invalidStorage(`${label} must be a real directory`);
    }
    await directory.sync();
  } catch (cause) {
    if (cause instanceof StudioDraftPersistenceError) {
      throw cause;
    }
    throw storageError(`Unable to sync ${label}`, cause);
  } finally {
    await directory?.close();
  }
}

export async function ensureStudioStorage(
  layout: StudioStorageLayout
): Promise<void> {
  await assertDirectory(layout.projectRoot, "Studio project root");
  await ensureDirectory(
    path.join(layout.projectRoot, ".luna"),
    "Luna state directory",
    false
  );
  await ensureDirectory(layout.studioRoot, "Studio storage directory", true);
  await ensureDirectory(layout.draftsRoot, "Studio drafts directory", true);
}

export function studioDraftDirectory(
  layout: StudioStorageLayout,
  draftId: string
): string {
  return path.join(layout.draftsRoot, draftId);
}

export function studioDraftStagingName(draftId: string): string {
  return `.creating-${draftId}`;
}

export function studioDraftFilePath(
  layout: StudioStorageLayout,
  draftId: string
): string {
  return path.join(studioDraftDirectory(layout, draftId), "change-set.json");
}

export function studioDraftCreationMarkerPath(
  layout: StudioStorageLayout,
  draftId: string
): string {
  return path.join(studioDraftDirectory(layout, draftId), ".creating");
}

export function studioDraftFilesDirectory(
  layout: StudioStorageLayout,
  draftId: string
): string {
  return path.join(studioDraftDirectory(layout, draftId), "files");
}

export async function ensureStudioDraftStorage(
  layout: StudioStorageLayout,
  draftId: string
): Promise<void> {
  await ensureDirectory(
    studioDraftDirectory(layout, draftId),
    "Studio draft directory",
    true
  );
  await ensureDirectory(
    studioDraftFilesDirectory(layout, draftId),
    "Studio draft files directory",
    true
  );
}

export async function assertStudioDraftStorage(
  layout: StudioStorageLayout,
  draftId: string
): Promise<boolean> {
  if (
    !(await assertExistingDirectory(
      studioDraftDirectory(layout, draftId),
      "Studio draft directory"
    ))
  ) {
    return false;
  }
  if (
    !(await assertExistingDirectory(
      studioDraftFilesDirectory(layout, draftId),
      "Studio draft files directory"
    ))
  ) {
    throw invalidStorage(
      `Studio draft ${draftId} is missing its private files directory`
    );
  }
  return true;
}

export function studioBlobFilePath(
  layout: StudioStorageLayout,
  draftId: string,
  digest: string
): string {
  const hexadecimal = digest.slice("sha256:".length);
  return path.join(studioDraftFilesDirectory(layout, draftId), hexadecimal);
}

export async function readPrivateFile(
  filePath: string,
  limit: StudioPrivateFileLimit
): Promise<Buffer | undefined> {
  let file;
  try {
    file = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) {
      return undefined;
    }
    if (isErrno(cause, "ELOOP")) {
      throw invalidStorage(`Refusing to read symbolic link: ${filePath}`, cause);
    }
    throw storageError(`Unable to open Studio storage file: ${filePath}`, cause);
  }

  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) {
      throw invalidStorage(`Studio storage entry is not a file: ${filePath}`);
    }
    assertStudioPrivateFileSize(metadata.size, limit);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remaining = limit.maxBytes + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        return Buffer.concat(chunks, totalBytes);
      }
      totalBytes += bytesRead;
      assertStudioPrivateFileSize(totalBytes, limit);
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } catch (cause) {
    if (cause instanceof StudioDraftPersistenceError) {
      throw cause;
    }
    throw storageError(`Unable to read Studio storage file: ${filePath}`, cause);
  } finally {
    await file.close();
  }
}

export async function writePrivateFile(
  filePath: string,
  content: string | Uint8Array,
  limit: StudioPrivateFileLimit,
  faultInjector?: (
    stage: AtomicWriteFaultStage
  ) => Promise<void> | void
): Promise<void> {
  const contentBytes =
    typeof content === "string"
      ? Buffer.byteLength(content, "utf8")
      : content.byteLength;
  assertStudioPrivateFileSize(contentBytes, limit);
  try {
    await writeFileAtomically(filePath, content, {
      mode: PRIVATE_FILE_MODE,
      errorCode: "studio_storage_io_failed",
      commitAmbiguousErrorCode: "studio_storage_commit_ambiguous",
      errorLabel: "Studio private file write",
      faultInjector
    });
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "commitState" in cause &&
      cause.commitState === "commit_ambiguous"
    ) {
      throw new StudioDraftPersistenceError(
        "studio_storage_commit_ambiguous",
        "Studio private file write may have committed",
        { cause }
      );
    }
    throw storageError(`Unable to write Studio storage file: ${filePath}`, cause);
  }
}

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

export async function removePrivateEntry(
  entryPath: string,
  options: StudioPrivateEntryRemovalOptions = {}
): Promise<void> {
  let inspected: StudioPrivateEntryIdentity;
  try {
    inspected = studioPrivateEntryIdentity(await lstat(entryPath));
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) {
      return;
    }
    throw storageError(
      "Unable to inspect Studio private storage entry before removal",
      cause
    );
  }

  if (
    options.expectedIdentity !== undefined &&
    !samePrivateEntryIdentity(inspected, options.expectedIdentity)
  ) {
    throw invalidStorage(
      "Studio private storage entry changed before removal"
    );
  }

  await options.faultInjector?.("after_private_entry_inspected");

  let current: StudioPrivateEntryIdentity;
  try {
    current = studioPrivateEntryIdentity(await lstat(entryPath));
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) {
      return;
    }
    throw storageError(
      "Unable to verify Studio private storage entry before removal",
      cause
    );
  }
  if (!samePrivateEntryIdentity(inspected, current)) {
    throw invalidStorage(
      "Studio private storage entry changed before removal"
    );
  }

  const quarantinePath = removalQuarantinePath(path.dirname(entryPath));
  try {
    await rename(entryPath, quarantinePath);
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) {
      return;
    }
    throw storageError(
      "Unable to quarantine Studio private storage entry",
      cause
    );
  }

  let quarantined: StudioPrivateEntryIdentity;
  try {
    quarantined = studioPrivateEntryIdentity(await lstat(quarantinePath));
  } catch (cause) {
    throw storageError(
      "Unable to verify quarantined Studio private storage entry",
      cause
    );
  }
  if (!samePrivateEntryIdentity(current, quarantined)) {
    throw invalidStorage(
      "Studio private storage entry changed while it was quarantined"
    );
  }

  try {
    // `rm` unlinks a final symbolic link instead of traversing it. The random
    // quarantine name also prevents a known target pathname from being swapped
    // between identity verification and recursive removal.
    await rm(quarantinePath, { recursive: true, force: false });
  } catch (cause) {
    throw storageError(
      "Unable to remove quarantined Studio private storage entry",
      cause
    );
  }
}
