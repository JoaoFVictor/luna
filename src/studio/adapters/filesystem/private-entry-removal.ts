import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  invalidStorage,
  isErrno,
  storageError
} from "./private-storage-errors.js";

const REMOVAL_QUARANTINE_PREFIX = ".removing-";

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
