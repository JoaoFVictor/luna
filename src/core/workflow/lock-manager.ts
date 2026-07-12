import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ObservabilityRecorder } from "../observability/tracing.js";
import { slugify } from "../security/path.js";
import { ActiveRunLockLease } from "./active-run-lock-lease.js";
import { isErrno } from "./lock-file-system.js";
import {
  RunLockOwnerPublisher,
  type LockMode
} from "./run-lock-owner.js";
import type { LockDiagnosticLogger } from "./run-lock-diagnostics.js";
import { StaleLockRecovery } from "./stale-lock-recovery.js";

export type { LockMode } from "./run-lock-owner.js";

export type RunLockManagerOptions = {
  root: string;
  runId: string;
  runtimeRunId?: string;
  timeoutMs: number;
  staleAfterMs: number;
  observability?: ObservabilityRecorder;
};

export type AcquireLockOptions = {
  timeoutMs?: number;
};

export type ReleaseLock = () => Promise<void>;

type RunLockErrorCode = "lock_config_invalid" | "lock_timeout";

type RunLockError = Error & {
  code: RunLockErrorCode;
  resource?: string;
};

function runLockError(
  message: string,
  code: RunLockErrorCode,
  resource?: string
): RunLockError {
  const error = new Error(message) as RunLockError;
  error.code = code;
  if (resource !== undefined) {
    error.resource = resource;
  }
  return error;
}

function validatePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw runLockError(
      `${label} must be a positive safe integer`,
      "lock_config_invalid"
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextContentionDelayMs(): number {
  return 25 + Math.floor(Math.random() * 25);
}

export class RunLockManager {
  private readonly root: string;
  private readonly timeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly observability: ObservabilityRecorder | undefined;
  private readonly ownerPublisher: RunLockOwnerPublisher;
  private readonly staleLockRecovery: StaleLockRecovery;

  constructor(options: RunLockManagerOptions) {
    validatePositiveSafeInteger(options.timeoutMs, "Lock timeoutMs");
    validatePositiveSafeInteger(options.staleAfterMs, "Lock staleAfterMs");
    const heartbeatIntervalMs = Math.min(
      30_000,
      Math.floor(options.staleAfterMs / 3)
    );
    if (heartbeatIntervalMs < 1000) {
      throw runLockError(
        "Lock staleAfterMs must allow a heartbeat interval of at least 1000ms",
        "lock_config_invalid"
      );
    }

    this.root = options.root;
    this.timeoutMs = options.timeoutMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.observability = options.observability;
    this.ownerPublisher = new RunLockOwnerPublisher(
      options.runId,
      options.runtimeRunId
    );
    this.staleLockRecovery = new StaleLockRecovery({
      staleAfterMs: options.staleAfterMs,
      log: this.log
    });
  }

  async acquire(
    resource: string,
    mode: LockMode,
    override: AcquireLockOptions = {}
  ): Promise<ReleaseLock> {
    const timeoutMs = override.timeoutMs ?? this.timeoutMs;
    validatePositiveSafeInteger(timeoutMs, "Lock timeoutMs");
    const deadline = Date.now() + timeoutMs;
    const lockDir = this.lockDir(resource);
    await mkdir(this.root, { recursive: true, mode: 0o700 });

    while (true) {
      try {
        await mkdir(lockDir, { recursive: false, mode: 0o700 });
        return await this.activateLock(resource, mode, lockDir);
      } catch (cause) {
        if (!isErrno(cause, "EEXIST")) {
          throw cause;
        }
      }

      await this.staleLockRecovery.tryRecover(resource, lockDir);
      if (Date.now() >= deadline) {
        const error = runLockError(
          `Timed out acquiring lock for ${resource}`,
          "lock_timeout",
          resource
        );
        this.log("error", "luna.lock.timeout", {
          "luna.resource": resource,
          mode,
          "error.code": "lock_timeout",
          timeout_ms: timeoutMs
        });
        throw error;
      }

      this.log("info", "luna.lock.waiting", {
        "luna.resource": resource,
        mode
      });
      await sleep(
        Math.min(nextContentionDelayMs(), Math.max(1, deadline - Date.now()))
      );
    }
  }

  private async activateLock(
    resource: string,
    mode: LockMode,
    lockDir: string
  ): Promise<ReleaseLock> {
    const lease = await ActiveRunLockLease.activate({
      resource,
      mode,
      lockDir,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      ownerPublisher: this.ownerPublisher,
      log: this.log
    });
    return async () => await lease.release();
  }

  private lockDir(resource: string): string {
    return path.join(this.root, `${slugify(resource.replace(/:/g, "_"))}.lock`);
  }

  private readonly log: LockDiagnosticLogger = (
    level,
    event,
    attributes
  ): void => {
    if (this.observability === undefined) {
      return;
    }

    void this.observability
      .log({
        level,
        message: event,
        attributes
      })
      .catch(() => {
        // Observability is diagnostic; lock behavior remains authoritative.
      });
  };
}
