import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { StudioDraftLockPort } from "../../application/drafts/persistence.js";
import { RunLockManager } from "../../../core/workflow/lock-manager.js";
import { StudioApplyError } from "../../application/apply/errors.js";

export type FileSystemStudioLockManagerOptions = {
  readonly projectRoot: string;
  readonly startupOwnerId?: string;
  readonly timeoutMs?: number;
  readonly staleAfterMs?: number;
};

const OWNER_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function isErrno(cause: unknown, code: string): boolean {
  return (cause as NodeJS.ErrnoException).code === code;
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

async function ensureRealDirectory(
  directory: string,
  mode: number,
  enforceMode: boolean
): Promise<void> {
  let created = false;
  try {
    await mkdir(directory, { mode });
    created = true;
  } catch (cause) {
    if (!isErrno(cause, "EEXIST")) {
      throw cause;
    }
  }
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new StudioApplyError(
      "studio_apply_path_invalid",
      "Studio lock storage must be a real directory"
    );
  }
  if (enforceMode) {
    await chmod(directory, mode);
  }
  await syncDirectory(directory);
  if (created) {
    await syncDirectory(path.dirname(directory));
  }
}

function resourceDigest(resource: string): string {
  return `studio-resource-${createHash("sha256")
    .update(resource, "utf8")
    .digest("hex")}`;
}

/**
 * Cross-process Studio lock adapter. It delegates ownership/heartbeat/stale
 * recovery to RunLockManager after pinning a private, non-symlink lock root.
 */
export class FileSystemStudioLockManager implements StudioDraftLockPort {
  private readonly projectRoot: string;
  private readonly startupOwnerId: string;
  private readonly timeoutMs: number;
  private readonly staleAfterMs: number;
  private manager: Promise<RunLockManager> | undefined;

  constructor(options: FileSystemStudioLockManagerOptions) {
    if (options.projectRoot.trim() === "") {
      throw new StudioApplyError(
        "studio_apply_config_invalid",
        "Studio lock project root cannot be blank"
      );
    }
    this.projectRoot = path.resolve(options.projectRoot);
    this.startupOwnerId =
      options.startupOwnerId ?? randomBytes(16).toString("hex");
    if (!OWNER_PATTERN.test(this.startupOwnerId)) {
      throw new StudioApplyError(
        "studio_apply_config_invalid",
        "Studio lock startup owner id is invalid"
      );
    }
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.staleAfterMs = options.staleAfterMs ?? 120_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new StudioApplyError(
        "studio_apply_config_invalid",
        "Studio lock timeout must be a positive safe integer"
      );
    }
    if (!Number.isSafeInteger(this.staleAfterMs) || this.staleAfterMs < 3_000) {
      throw new StudioApplyError(
        "studio_apply_config_invalid",
        "Studio lock stale interval must be a safe integer of at least 3000ms"
      );
    }
  }

  async acquire(
    resource: string,
    mode: "exclusive"
  ): Promise<() => Promise<void>> {
    if (resource.trim() === "" || resource.length > 1_024) {
      throw new StudioApplyError(
        "studio_apply_config_invalid",
        "Studio lock resource id is invalid"
      );
    }
    const manager = await this.lockManager();
    return await manager.acquire(resourceDigest(resource), mode);
  }

  private lockManager(): Promise<RunLockManager> {
    this.manager ??= this.initialize();
    return this.manager;
  }

  private async initialize(): Promise<RunLockManager> {
    const projectEntry = await lstat(this.projectRoot);
    if (projectEntry.isSymbolicLink() || !projectEntry.isDirectory()) {
      throw new StudioApplyError(
        "studio_apply_path_invalid",
        "Studio lock project root must be a real directory"
      );
    }
    const physicalProjectRoot = await realpath(this.projectRoot);
    if (physicalProjectRoot !== this.projectRoot) {
      throw new StudioApplyError(
        "studio_apply_path_invalid",
        "Studio lock project root must already be physically resolved"
      );
    }

    const lunaRoot = path.join(physicalProjectRoot, ".luna");
    const studioRoot = path.join(lunaRoot, "studio");
    const lockRoot = path.join(studioRoot, "locks");
    await ensureRealDirectory(lunaRoot, 0o700, false);
    await ensureRealDirectory(studioRoot, 0o700, true);
    await ensureRealDirectory(lockRoot, 0o700, true);

    if ((await realpath(lockRoot)) !== lockRoot) {
      throw new StudioApplyError(
        "studio_apply_path_invalid",
        "Studio lock root must not resolve through a symbolic link"
      );
    }
    return new RunLockManager({
      root: lockRoot,
      runId: this.startupOwnerId,
      timeoutMs: this.timeoutMs,
      staleAfterMs: this.staleAfterMs
    });
  }
}

