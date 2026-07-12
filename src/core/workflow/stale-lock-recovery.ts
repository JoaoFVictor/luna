import type { Stats } from "node:fs";
import {
  lstat,
  readdir,
  rename,
  rmdir,
  rm
} from "node:fs/promises";
import path from "node:path";
import {
  acquisitionToken,
  isErrno,
  restoreQuarantineBestEffort
} from "./lock-file-system.js";
import {
  inspectProcess,
  sameProcessIdentity
} from "./lock-process-identity.js";
import {
  isOwnerClaimEntry,
  lockOwnerFileExists,
  readLockOwner,
  type LockOwnerMetadata
} from "./run-lock-owner.js";
import type { LockDiagnosticLogger } from "./run-lock-diagnostics.js";

type StaleLockRecoveryOptions = {
  staleAfterMs: number;
  log: LockDiagnosticLogger;
};

export class StaleLockRecovery {
  private readonly staleAfterMs: number;
  private readonly log: LockDiagnosticLogger;

  constructor(options: StaleLockRecoveryOptions) {
    this.staleAfterMs = options.staleAfterMs;
    this.log = options.log;
  }

  async tryRecover(resource: string, lockDir: string): Promise<void> {
    const owner = await readLockOwner(lockDir);
    if (owner === undefined) {
      if (!(await lockOwnerFileExists(lockDir))) {
        await this.tryRecoverOwnerless(resource, lockDir);
        return;
      }
      this.log("warn", "luna.lock.owner_metadata_corrupt", {
        "luna.resource": resource
      });
      return;
    }

    const heartbeatAtMs = Date.parse(owner.heartbeat_at);
    if (!Number.isFinite(heartbeatAtMs)) {
      this.log("warn", "luna.lock.owner_metadata_corrupt", {
        "luna.resource": resource
      });
      return;
    }

    if (Date.now() - heartbeatAtMs < this.staleAfterMs) {
      return;
    }

    if (!(await this.isOwnerRecoverable(owner))) {
      return;
    }

    await this.quarantineAndRecoverOwner(resource, lockDir, owner);
  }

  private async quarantineAndRecoverOwner(
    resource: string,
    lockDir: string,
    owner: LockOwnerMetadata
  ): Promise<void> {
    const quarantine = `${lockDir}.stale-${
      owner.owner_token ?? "legacy"
    }-${acquisitionToken()}`;
    try {
      await rename(lockDir, quarantine);
    } catch (cause) {
      if (isErrno(cause, "ENOENT") || isErrno(cause, "EEXIST")) {
        return;
      }
      throw cause;
    }

    const quarantinedOwner = await readLockOwner(quarantine);
    if (!this.isSameRecoveryCandidate(owner, quarantinedOwner)) {
      await restoreQuarantineBestEffort(quarantine, lockDir);
      return;
    }

    const quarantinedHeartbeatAtMs = Date.parse(quarantinedOwner.heartbeat_at);
    if (
      !Number.isFinite(quarantinedHeartbeatAtMs) ||
      Date.now() - quarantinedHeartbeatAtMs < this.staleAfterMs ||
      !(await this.isOwnerRecoverable(quarantinedOwner))
    ) {
      await restoreQuarantineBestEffort(quarantine, lockDir);
      return;
    }

    await rm(quarantine, { recursive: true, force: true });
    this.log("warn", "luna.lock.stale_recovered", {
      "luna.resource": resource,
      owner_run_id: owner.run_id,
      owner_pid: owner.pid
    });
  }

  private isSameRecoveryCandidate(
    owner: LockOwnerMetadata,
    quarantinedOwner: LockOwnerMetadata | undefined
  ): quarantinedOwner is LockOwnerMetadata {
    return quarantinedOwner !== undefined &&
      quarantinedOwner.pid === owner.pid &&
      quarantinedOwner.run_id === owner.run_id &&
      quarantinedOwner.owner_token === owner.owner_token &&
      quarantinedOwner.resource === owner.resource &&
      quarantinedOwner.mode === owner.mode &&
      quarantinedOwner.runtime_run_id === owner.runtime_run_id &&
      (owner.owner_token !== undefined ||
        quarantinedOwner.heartbeat_at === owner.heartbeat_at) &&
      (owner.process_identity === undefined ||
        (quarantinedOwner.process_identity !== undefined &&
          sameProcessIdentity(
            quarantinedOwner.process_identity,
            owner.process_identity
          )));
  }

  private async isOwnerRecoverable(owner: LockOwnerMetadata): Promise<boolean> {
    const processInspection = await inspectProcess(owner.pid);
    if (!processInspection.live) {
      return true;
    }
    if (
      owner.process_identity !== undefined &&
      processInspection.identity !== undefined
    ) {
      return !sameProcessIdentity(
        owner.process_identity,
        processInspection.identity
      );
    }

    // A live PID without a strong identity is deliberately non-recoverable.
    // Age alone cannot distinguish a paused holder from PID reuse, and stealing
    // this run-scoped lease could execute downstream effects concurrently.
    return false;
  }

  private async tryRecoverOwnerless(
    resource: string,
    lockDir: string
  ): Promise<void> {
    const metadata = await this.readLockDirectoryStats(lockDir);
    if (
      metadata === undefined ||
      !metadata.isDirectory() ||
      !Number.isFinite(metadata.mtimeMs) ||
      Date.now() - metadata.mtimeMs < this.staleAfterMs
    ) {
      return;
    }

    const initialEntries = await this.readDirectoryIfPresent(lockDir);
    if (initialEntries === undefined) {
      return;
    }
    if (initialEntries.some((entry) => !isOwnerClaimEntry(entry))) {
      this.log("warn", "luna.lock.ownerless_contents_ambiguous", {
        "luna.resource": resource
      });
      return;
    }

    const quarantine = `${lockDir}.ownerless-${acquisitionToken()}`;
    try {
      await rename(lockDir, quarantine);
    } catch (cause) {
      if (isErrno(cause, "ENOENT") || isErrno(cause, "EEXIST")) {
        return;
      }
      throw cause;
    }

    if (!(await this.deleteOwnerlessQuarantine(quarantine, lockDir))) {
      return;
    }

    this.log("warn", "luna.lock.ownerless_stale_recovered", {
      "luna.resource": resource
    });
  }

  private async deleteOwnerlessQuarantine(
    quarantine: string,
    lockDir: string
  ): Promise<boolean> {
    try {
      const entries = await readdir(quarantine);
      if (
        (await lockOwnerFileExists(quarantine)) ||
        entries.some((entry) => !isOwnerClaimEntry(entry))
      ) {
        await restoreQuarantineBestEffort(quarantine, lockDir);
        return false;
      }
      for (const entry of entries) {
        await rm(path.join(quarantine, entry), { force: true });
      }
      await rmdir(quarantine);
      return true;
    } catch (cause) {
      if (isErrno(cause, "ENOTEMPTY") || isErrno(cause, "EEXIST")) {
        await restoreQuarantineBestEffort(quarantine, lockDir);
        return false;
      }
      if (!isErrno(cause, "ENOENT")) {
        throw cause;
      }
      return true;
    }
  }

  private async readLockDirectoryStats(lockDir: string): Promise<Stats | undefined> {
    try {
      return await lstat(lockDir);
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) {
        return undefined;
      }
      throw cause;
    }
  }

  private async readDirectoryIfPresent(
    lockDir: string
  ): Promise<string[] | undefined> {
    try {
      return await readdir(lockDir);
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) {
        return undefined;
      }
      throw cause;
    }
  }
}
