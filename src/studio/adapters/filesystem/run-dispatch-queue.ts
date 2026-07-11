import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../../../core/workflow/definition-digests.js";
import { studioRunDigestsEqual, studioRunValueDigest } from "../../application/runs/launch-digests.js";
import {
  StudioRunLaunchError,
  studioRunLaunchError
} from "../../application/runs/launch-errors.js";
import { RunOpaqueIdSchema } from "../../contracts/runs.js";
import {
  isNativeStudioRunSnapshotIntegrityFailure,
  materializeNativeStudioRunSnapshot,
  verifyMaterializedNativeStudioRunSnapshot
} from "../native/run-definition-snapshot.js";
import type { NativeStudioRunSnapshot } from "../native/run-snapshot-contracts.js";
import {
  NativeStudioQueuedRunMaterialSchema,
  NativeStudioQueuedRunSchema,
  nativeStudioQueuedRunMaterial,
  type NativeStudioQueuedRun,
  type NativeStudioQueuedRunMaterial
} from "./run-dispatch-contracts.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_JOB_FILE_BYTES = 4 * 1024 * 1024;
const MAX_QUEUE_SCAN_ENTRIES = 10_000;
const MAX_LIST_SCAN_PAGES = 1_024;

export type NativeStudioRunDispatchQueueScan = {
  readonly runIds: readonly string[];
  readonly ignoredEntryCount: number;
  readonly complete: boolean;
};

export type NativeStudioRunDispatchQueueInspection =
  | "present"
  | "missing"
  | "corrupt";

function queueError(message: string, cause?: unknown): Error {
  return studioRunLaunchError(
    "studio_run_dispatch_failed",
    message,
    {},
    cause === undefined ? undefined : { cause }
  );
}

function queueCorruptionError(message: string, cause?: unknown): Error {
  return studioRunLaunchError(
    "studio_run_dispatch_failed",
    message,
    { queue_corruption: true },
    cause === undefined ? undefined : { cause }
  );
}

export function isNativeStudioRunDispatchQueueCorruption(
  cause: unknown
): boolean {
  return cause instanceof StudioRunLaunchError &&
    cause.details.queue_corruption === true;
}

function isErrno(cause: unknown, ...codes: readonly string[]): boolean {
  return codes.includes((cause as NodeJS.ErrnoException).code ?? "");
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw queueError("Native run dispatch storage must use physical directories");
  }
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await handle.chmod(PRIVATE_DIRECTORY_MODE);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryTree(directory: string): Promise<void> {
  const entries = await opendir(directory);
  try {
    for await (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw queueError("Native run dispatch storage contains a symbolic link");
      }
      if (entry.isDirectory()) {
        await syncDirectoryTree(path.join(directory, entry.name));
      }
    }
  } finally {
    await entries.close().catch(() => undefined);
  }
  await syncDirectory(directory);
}

async function writeDurableFile(filePath: string, content: string): Promise<void> {
  const handle = await open(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function queuedRunWithHash(
  material: NativeStudioQueuedRunMaterial
): NativeStudioQueuedRun {
  const parsed = NativeStudioQueuedRunMaterialSchema.parse(material);
  return NativeStudioQueuedRunSchema.parse({
    ...parsed,
    command_hash: studioRunValueDigest(parsed)
  });
}

export type NativeStudioRunDispatchQueueOptions = {
  readonly root: string;
};

export class NativeStudioRunDispatchQueue {
  readonly #root: string;
  readonly #jobsRoot: string;
  #scanOffset = 0;

  constructor(options: NativeStudioRunDispatchQueueOptions) {
    this.#root = path.resolve(options.root);
    this.#jobsRoot = path.join(this.#root, "jobs");
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.#root);
    await ensurePrivateDirectory(this.#jobsRoot);
    await this.removeAbandonedStagingDirectories();
  }

  async accept(
    material: NativeStudioQueuedRunMaterial,
    snapshot: NativeStudioRunSnapshot
  ): Promise<{ readonly job: NativeStudioQueuedRun; readonly created: boolean }> {
    const job = queuedRunWithHash(material);
    if (
      job.snapshot.bundle_hash !== snapshot.bundle_hash ||
      job.snapshot.total_bytes !== snapshot.total_bytes
    ) {
      throw queueError("Queued run snapshot does not match its durable manifest");
    }
    const finalDirectory = this.jobDirectory(job.run_id);
    const stagingDirectory = path.join(
      this.#jobsRoot,
      `.creating-${job.run_id}-${randomBytes(8).toString("hex")}`
    );
    await mkdir(stagingDirectory, { mode: PRIVATE_DIRECTORY_MODE });
    try {
      const roots = this.snapshotRoots(stagingDirectory);
      await materializeNativeStudioRunSnapshot(snapshot, roots);
      await writeDurableFile(
        path.join(stagingDirectory, "job.json"),
        canonicalJson(job)
      );
      await syncDirectoryTree(stagingDirectory);
      try {
        await rename(stagingDirectory, finalDirectory);
        await syncDirectory(this.#jobsRoot);
        return { job, created: true };
      } catch (cause) {
        if (!isErrno(cause, "EEXIST", "ENOTEMPTY")) {
          throw cause;
        }
      }
    } catch (cause) {
      throw queueError("Native run could not be durably queued", cause);
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }

    const existing = await this.read(job.run_id);
    if (
      !studioRunDigestsEqual(
        existing.idempotency_binding_hash,
        job.idempotency_binding_hash
      ) ||
      !studioRunDigestsEqual(
        existing.execution_snapshot_hash,
        job.execution_snapshot_hash
      )
    ) {
      throw queueError("Run id was already queued with different content");
    }
    return { job: existing, created: false };
  }

  async listRunIds(): Promise<readonly string[]> {
    const ids = new Set<string>();
    let offset = 0;
    for (let page = 0; page < MAX_LIST_SCAN_PAGES; page += 1) {
      const { scan, nextOffset } = await this.scanRunIdsAtOffset(offset);
      scan.runIds.forEach((runId) => ids.add(runId));
      if (scan.complete) {
        break;
      }
      offset = nextOffset;
    }
    return [...ids].sort((left, right) => left.localeCompare(right));
  }

  async scanRunIds(): Promise<NativeStudioRunDispatchQueueScan> {
    const { scan, nextOffset } = await this.scanRunIdsAtOffset(this.#scanOffset);
    this.#scanOffset = scan.complete ? 0 : nextOffset;
    return scan;
  }

  private async scanRunIdsAtOffset(startOffset: number): Promise<{
    readonly scan: NativeStudioRunDispatchQueueScan;
    readonly nextOffset: number;
  }> {
    const handle = await opendir(this.#jobsRoot);
    const ids: string[] = [];
    let skipped = 0;
    let pageEntries = 0;
    let ignoredEntryCount = 0;
    let hasMore = false;
    try {
      for await (const entry of handle) {
        if (
          entry.name.startsWith(".creating-") ||
          entry.name.startsWith(".deleting-")
        ) {
          continue;
        }
        if (skipped < startOffset) {
          skipped += 1;
          continue;
        }
        if (pageEntries >= MAX_QUEUE_SCAN_ENTRIES) {
          hasMore = true;
          break;
        }
        pageEntries += 1;
        const parsed = RunOpaqueIdSchema.safeParse(entry.name);
        if (!parsed.success) {
          ignoredEntryCount += 1;
          continue;
        }
        ids.push(parsed.data);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    return {
      scan: {
        runIds: ids.sort((left, right) => left.localeCompare(right)),
        ignoredEntryCount,
        complete: !hasMore
      },
      nextOffset: hasMore ? startOffset + pageEntries : 0
    };
  }

  async read(runId: string): Promise<NativeStudioQueuedRun> {
    const id = RunOpaqueIdSchema.parse(runId);
    const directory = this.jobDirectory(id);
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch (cause) {
      if (isErrno(cause, "ENOENT", "ENOTDIR", "ELOOP")) {
        throw queueCorruptionError(
          "Native run dispatch job directory is missing or invalid",
          cause
        );
      }
      throw cause;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw queueCorruptionError(
        "Native run dispatch job is not a physical directory"
      );
    }
    let file;
    try {
      file = await open(
        path.join(directory, "job.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
    } catch (cause) {
      if (isErrno(cause, "ENOENT", "ENOTDIR", "ELOOP", "EISDIR")) {
        throw queueCorruptionError(
          "Native run dispatch job file is missing or invalid",
          cause
        );
      }
      throw cause;
    }
    let content: Buffer;
    try {
      const metadata = await file.stat({ bigint: true });
      if (!metadata.isFile() || metadata.size > MAX_JOB_FILE_BYTES) {
        throw queueCorruptionError(
          "Native run dispatch job exceeds its read limit"
        );
      }
      content = await file.readFile();
      const final = await file.stat({ bigint: true });
      if (
        !final.isFile() ||
        final.dev !== metadata.dev ||
        final.ino !== metadata.ino ||
        final.size !== metadata.size ||
        final.mtimeNs !== metadata.mtimeNs ||
        BigInt(content.byteLength) !== metadata.size
      ) {
        throw queueCorruptionError(
          "Native run dispatch job changed while reading"
        );
      }
    } finally {
      await file.close();
    }
    let raw: unknown;
    try {
      raw = JSON.parse(content.toString("utf8"));
    } catch (cause) {
      throw queueCorruptionError(
        "Native run dispatch job is not valid JSON",
        cause
      );
    }
    const parsedJob = NativeStudioQueuedRunSchema.safeParse(raw);
    if (!parsedJob.success) {
      throw queueCorruptionError("Native run dispatch job is invalid");
    }
    const job = parsedJob.data;
    if (
      job.run_id !== id ||
      !studioRunDigestsEqual(
        job.command_hash,
        studioRunValueDigest(nativeStudioQueuedRunMaterial(job))
      )
    ) {
      throw queueCorruptionError(
        "Native run dispatch job failed integrity validation"
      );
    }
    try {
      await verifyMaterializedNativeStudioRunSnapshot({
        roots: this.snapshotRoots(directory),
        manifest: job.snapshot
      });
    } catch (cause) {
      if (isNativeStudioRunSnapshotIntegrityFailure(cause)) {
        throw queueCorruptionError(
          "Native run dispatch snapshot failed integrity validation",
          cause
        );
      }
      throw cause;
    }
    return job;
  }

  async inspect(
    runId: string
  ): Promise<NativeStudioRunDispatchQueueInspection> {
    const id = RunOpaqueIdSchema.parse(runId);
    try {
      const metadata = await lstat(this.jobDirectory(id));
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        return "corrupt";
      }
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) {
        return "missing";
      }
      if (isErrno(cause, "ENOTDIR", "ELOOP")) {
        return "corrupt";
      }
      throw cause;
    }
    try {
      await this.read(id);
      return "present";
    } catch (cause) {
      if (isNativeStudioRunDispatchQueueCorruption(cause)) {
        // Terminal cleanup atomically renames the job after the first lstat.
        // If that happened while read() was opening the immutable material,
        // the current queue state is missing rather than corrupt.
        try {
          await lstat(this.jobDirectory(id));
        } catch (verificationCause) {
          if (isErrno(verificationCause, "ENOENT")) {
            return "missing";
          }
          if (!isErrno(verificationCause, "ENOTDIR", "ELOOP")) {
            throw verificationCause;
          }
        }
        return "corrupt";
      }
      throw cause;
    }
  }

  snapshotRootsFor(runId: string): {
    readonly projectRoot: string;
    readonly configRoot: string;
  } {
    return this.snapshotRoots(this.jobDirectory(RunOpaqueIdSchema.parse(runId)));
  }

  async removeTerminalJob(runId: string): Promise<void> {
    const id = RunOpaqueIdSchema.parse(runId);
    const source = this.jobDirectory(id);
    const deleting = path.join(
      this.#jobsRoot,
      `.deleting-${id}-${randomBytes(8).toString("hex")}`
    );
    try {
      const metadata = await lstat(source);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw queueError("Native run dispatch job is not a physical directory");
      }
      await rename(source, deleting);
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) {
        return;
      }
      throw queueError("Terminal native run could not leave the dispatch queue", cause);
    }
    try {
      await syncDirectory(this.#jobsRoot);
      await rm(deleting, { recursive: true, force: true });
      await syncDirectory(this.#jobsRoot);
    } catch (cause) {
      await rm(deleting, { recursive: true, force: true }).catch(() => undefined);
      await syncDirectory(this.#jobsRoot).catch(() => undefined);
      throw queueError("Terminal native run could not be removed durably", cause);
    }
  }

  async removeAbandonedTerminalJobs(): Promise<void> {
    const handle = await opendir(this.#jobsRoot);
    let removed = false;
    let firstFailure: unknown;
    try {
      for await (const entry of handle) {
        if (!entry.name.startsWith(".deleting-")) {
          continue;
        }
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          firstFailure ??= queueError(
            "Native run dispatch deletion entry is invalid"
          );
          continue;
        }
        try {
          await rm(path.join(this.#jobsRoot, entry.name), {
            recursive: true,
            force: true
          });
          removed = true;
        } catch (cause) {
          firstFailure ??= cause;
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (removed) {
      try {
        await syncDirectory(this.#jobsRoot);
      } catch (cause) {
        firstFailure ??= cause;
      }
    }
    if (firstFailure !== undefined) {
      throw queueError(
        "Abandoned terminal native runs could not be removed durably",
        firstFailure
      );
    }
  }

  private jobDirectory(runId: string): string {
    return path.join(this.#jobsRoot, runId);
  }

  private snapshotRoots(directory: string): {
    readonly projectRoot: string;
    readonly configRoot: string;
  } {
    return {
      projectRoot: path.join(directory, "snapshot", "project"),
      configRoot: path.join(directory, "snapshot", "config")
    };
  }

  private async removeAbandonedStagingDirectories(): Promise<void> {
    const handle = await opendir(this.#jobsRoot);
    try {
      for await (const entry of handle) {
        if (
          !entry.name.startsWith(".creating-") &&
          !entry.name.startsWith(".deleting-")
        ) {
          continue;
        }
        const candidate = path.join(this.#jobsRoot, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          await rm(candidate, { recursive: true, force: true });
        } else {
          await unlink(candidate).catch((cause) => {
            if (!isErrno(cause, "ENOENT")) throw cause;
          });
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    await syncDirectory(this.#jobsRoot);
  }
}
