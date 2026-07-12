import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { StudioDraftPersistenceError } from "../../application/drafts/persistence.js";
import {
  invalidStorage,
  isErrno,
  storageError
} from "./private-storage-errors.js";

const PRIVATE_DIRECTORY_MODE = 0o700;

export type StudioStorageLayout = {
  readonly projectRoot: string;
  readonly studioRoot: string;
  readonly draftsRoot: string;
};

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
