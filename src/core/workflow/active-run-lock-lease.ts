import { rename, rm } from "node:fs/promises";
import {
  acquisitionToken,
  isErrno,
  restoreQuarantineBestEffort
} from "./lock-file-system.js";
import {
  readLockOwner,
  readLockOwnerForRelease,
  RunLockOwnerPublisher,
  type LockMode
} from "./run-lock-owner.js";
import type { LockDiagnosticLogger } from "./run-lock-diagnostics.js";

type LockReleaseProgress = {
  quarantinePath?: string;
};

type ReleaseState = "active" | "release_requested" | "released";

type ActiveRunLockLeaseOptions = {
  resource: string;
  mode: LockMode;
  lockDir: string;
  heartbeatIntervalMs: number;
  ownerPublisher: RunLockOwnerPublisher;
  log: LockDiagnosticLogger;
};

const RELEASE_RETRY_DELAY_MS = 25;
const MAX_RELEASE_RETRY_DELAY_MS = 1000;

export class ActiveRunLockLease {
  private readonly resource: string;
  private readonly mode: LockMode;
  private readonly lockDir: string;
  private readonly heartbeatIntervalMs: number;
  private readonly ownerPublisher: RunLockOwnerPublisher;
  private readonly log: LockDiagnosticLogger;
  private readonly ownerToken = acquisitionToken();
  private readonly releaseProgress: LockReleaseProgress = {};
  private releaseState: ReleaseState = "active";
  private releaseAttempt: Promise<void> | undefined;
  private releaseRetry: NodeJS.Timeout | undefined;
  private releaseRetryDelayMs = RELEASE_RETRY_DELAY_MS;
  private heartbeat: NodeJS.Timeout | undefined;
  private heartbeatTail = Promise.resolve();

  private constructor(options: ActiveRunLockLeaseOptions) {
    this.resource = options.resource;
    this.mode = options.mode;
    this.lockDir = options.lockDir;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.ownerPublisher = options.ownerPublisher;
    this.log = options.log;
  }

  static async activate(
    options: ActiveRunLockLeaseOptions
  ): Promise<ActiveRunLockLease> {
    const lease = new ActiveRunLockLease(options);
    await lease.publishOwnership();
    lease.startHeartbeat();
    lease.log("info", "luna.lock.acquired", {
      "luna.resource": lease.resource,
      mode: lease.mode
    });
    return lease;
  }

  async release(): Promise<void> {
    if (this.releaseState === "released") {
      return;
    }
    if (this.releaseAttempt !== undefined) {
      return await this.releaseAttempt;
    }

    this.releaseState = "release_requested";
    this.stopHeartbeat();
    const attempt = this.completeRelease();
    this.releaseAttempt = attempt;
    try {
      await attempt;
    } finally {
      if (this.releaseAttempt === attempt) {
        this.releaseAttempt = undefined;
      }
    }
  }

  private async publishOwnership(): Promise<void> {
    try {
      await this.ownerPublisher.publish(
        this.lockDir,
        this.resource,
        this.mode,
        this.ownerToken
      );
      const published = await readLockOwner(this.lockDir);
      if (published?.owner_token !== this.ownerToken) {
        throw new Error("Lock ownership changed while it was being published");
      }
    } catch (cause) {
      try {
        await this.releaseIfCurrent();
      } catch {
        // A failed activation never deletes a path it cannot prove it owns.
        // Ownerless remnants are recovered only after staleAfterMs.
      }
      throw cause;
    }
  }

  private startHeartbeat(): void {
    if (this.releaseState !== "active" || this.heartbeat !== undefined) {
      return;
    }
    this.heartbeat = setInterval(
      () => this.enqueueHeartbeat(),
      this.heartbeatIntervalMs
    );
    this.heartbeat.unref();
  }

  private enqueueHeartbeat(): void {
    this.heartbeatTail = this.heartbeatTail
      .then(async () => {
        if (this.releaseState !== "active") {
          return;
        }
        await this.ownerPublisher.refreshIfCurrent(
          this.lockDir,
          this.resource,
          this.mode,
          this.ownerToken
        );
      })
      .catch((cause) => {
        this.log("warn", "luna.lock.heartbeat.failed", {
          "luna.resource": this.resource,
          mode: this.mode,
          error: cause instanceof Error ? cause.message : String(cause)
        });
      });
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private async completeRelease(): Promise<void> {
    try {
      await this.heartbeatTail;
      await this.releaseIfCurrent();
      this.releaseState = "released";
      this.clearReleaseRetry();
      this.log("info", "luna.lock.released", {
        "luna.resource": this.resource,
        mode: this.mode
      });
    } catch (cause) {
      this.scheduleReleaseRetry();
      throw cause;
    }
  }

  private scheduleReleaseRetry(): void {
    if (
      this.releaseState !== "release_requested" ||
      this.releaseRetry !== undefined
    ) {
      return;
    }
    const delayMs = this.releaseRetryDelayMs;
    this.releaseRetryDelayMs = Math.min(
      MAX_RELEASE_RETRY_DELAY_MS,
      this.releaseRetryDelayMs * 2
    );
    this.releaseRetry = setTimeout(() => {
      this.releaseRetry = undefined;
      void this.release().catch((cause) => {
        this.log("warn", "luna.lock.release.retry_failed", {
          "luna.resource": this.resource,
          mode: this.mode,
          error: cause instanceof Error ? cause.message : String(cause)
        });
      });
    }, delayMs);
    this.releaseRetry.unref();
  }

  private clearReleaseRetry(): void {
    if (this.releaseRetry !== undefined) {
      clearTimeout(this.releaseRetry);
      this.releaseRetry = undefined;
    }
  }

  private async releaseIfCurrent(): Promise<void> {
    if (this.releaseProgress.quarantinePath !== undefined) {
      await rm(this.releaseProgress.quarantinePath, {
        recursive: true,
        force: true
      });
      this.releaseProgress.quarantinePath = undefined;
      return;
    }

    const quarantine = `${this.lockDir}.released-${this.ownerToken}`;
    const pendingOwner = await readLockOwnerForRelease(quarantine);
    if (pendingOwner?.owner_token === this.ownerToken) {
      this.releaseProgress.quarantinePath = quarantine;
      await rm(quarantine, { recursive: true, force: true });
      this.releaseProgress.quarantinePath = undefined;
      return;
    }

    const owner = await readLockOwnerForRelease(this.lockDir);
    if (owner?.owner_token !== this.ownerToken) {
      return;
    }

    try {
      await rename(this.lockDir, quarantine);
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) {
        return;
      }
      throw cause;
    }

    const quarantinedOwner = await readLockOwner(quarantine);
    if (quarantinedOwner?.owner_token !== this.ownerToken) {
      await restoreQuarantineBestEffort(quarantine, this.lockDir);
      return;
    }

    // Ownership proof stays on this lease. Recursive rm may remove owner.json
    // before failing on a later child; retries continue deleting the already-
    // proven quarantine without depending on metadata that may be gone.
    this.releaseProgress.quarantinePath = quarantine;
    await rm(quarantine, { recursive: true, force: true });
    this.releaseProgress.quarantinePath = undefined;
  }
}
