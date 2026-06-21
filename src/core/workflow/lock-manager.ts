import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  customEvent,
  type LunaObservability
} from "../observability/luna-observability.js";
import { sanitizeJsonObject } from "../observability/sanitize.js";
import { slugify } from "../security/path.js";

export type LockMode = "exclusive";

export type RunLockManagerOptions = {
  root: string;
  runId: string;
  runtimeRunId?: string;
  timeoutMs: number;
  staleAfterMs: number;
  observability?: LunaObservability;
};

export type AcquireLockOptions = {
  timeoutMs?: number;
};

export type ReleaseLock = () => Promise<void>;

type LockOwnerMetadata = {
  resource: string;
  mode: LockMode;
  run_id: string;
  runtime_run_id?: string;
  owner_token?: string;
  pid: number;
  heartbeat_at: string;
};

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextContentionDelayMs(): number {
  return 25 + Math.floor(Math.random() * 25);
}

function acquisitionToken(): string {
  return randomBytes(8).toString("hex");
}

function validatePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw runLockError(`${label} must be a positive safe integer`, "lock_config_invalid");
  }
}

function isErrno(cause: unknown, code: string): boolean {
  return (cause as NodeJS.ErrnoException).code === code;
}

function isProcessLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !isErrno(cause, "ESRCH");
  }
}

function parseOwnerMetadata(content: string): LockOwnerMetadata | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as LockOwnerMetadata).resource !== "string" ||
    (parsed as LockOwnerMetadata).mode !== "exclusive" ||
    typeof (parsed as LockOwnerMetadata).run_id !== "string" ||
    typeof (parsed as LockOwnerMetadata).pid !== "number" ||
    !Number.isSafeInteger((parsed as LockOwnerMetadata).pid) ||
    typeof (parsed as LockOwnerMetadata).heartbeat_at !== "string"
  ) {
    return undefined;
  }

  const runtimeRunId = (parsed as LockOwnerMetadata).runtime_run_id;
  if (runtimeRunId !== undefined && typeof runtimeRunId !== "string") {
    return undefined;
  }

  const ownerToken = (parsed as LockOwnerMetadata).owner_token;
  if (ownerToken !== undefined && typeof ownerToken !== "string") {
    return undefined;
  }

  return parsed as LockOwnerMetadata;
}

export class RunLockManager {
  private readonly root: string;
  private readonly runId: string;
  private readonly runtimeRunId: string | undefined;
  private readonly timeoutMs: number;
  private readonly staleAfterMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly observability: LunaObservability | undefined;

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
    this.runId = options.runId;
    this.runtimeRunId = options.runtimeRunId;
    this.timeoutMs = options.timeoutMs;
    this.staleAfterMs = options.staleAfterMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.observability = options.observability;
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

      await this.tryRecoverStaleLock(resource, lockDir);
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
    let released = false;
    let heartbeat: NodeJS.Timeout | undefined;
    const token = acquisitionToken();

    const writeOwner = async () => {
      await this.writeOwnerIfCurrent(lockDir, resource, mode, token);
    };

    try {
      await this.writeOwner(lockDir, resource, mode, token);
    } catch (cause) {
      await rm(lockDir, { recursive: true, force: true });
      throw cause;
    }

    heartbeat = setInterval(() => {
      void writeOwner().catch((cause) => {
        this.log("warn", "luna.lock.heartbeat.failed", {
          "luna.resource": resource,
          mode,
          error: cause instanceof Error ? cause.message : String(cause)
        });
      });
    }, this.heartbeatIntervalMs);
    heartbeat.unref();

    this.log("info", "luna.lock.acquired", {
      "luna.resource": resource,
      mode
    });

    return async () => {
      if (released) {
        return;
      }
      released = true;
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
      }
      await this.releaseIfCurrent(lockDir, token);
      this.log("info", "luna.lock.released", {
        "luna.resource": resource,
        mode
      });
    };
  }

  private lockDir(resource: string): string {
    return path.join(this.root, `${slugify(resource.replace(/:/g, "_"))}.lock`);
  }

  private ownerMetadata(
    resource: string,
    mode: LockMode,
    ownerToken: string
  ): LockOwnerMetadata {
    return {
      resource,
      mode,
      run_id: this.runId,
      ...(this.runtimeRunId === undefined
        ? {}
        : { runtime_run_id: this.runtimeRunId }),
      owner_token: ownerToken,
      pid: process.pid,
      heartbeat_at: new Date().toISOString()
    };
  }

  private ownerPath(directory: string): string {
    return path.join(directory, "owner.json");
  }

  private async readOwner(directory: string): Promise<LockOwnerMetadata | undefined> {
    let content: string;
    try {
      content = await readFile(this.ownerPath(directory), "utf8");
    } catch {
      return undefined;
    }

    return parseOwnerMetadata(content);
  }

  private async writeOwner(
    directory: string,
    resource: string,
    mode: LockMode,
    ownerToken: string
  ): Promise<void> {
    await writeFile(
      this.ownerPath(directory),
      `${JSON.stringify(this.ownerMetadata(resource, mode, ownerToken), null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }

  private async writeOwnerIfCurrent(
    directory: string,
    resource: string,
    mode: LockMode,
    ownerToken: string
  ): Promise<void> {
    const owner = await this.readOwner(directory);
    if (owner?.owner_token !== ownerToken) {
      return;
    }

    const tempPath = path.join(directory, `owner.${ownerToken}.tmp`);
    await writeFile(
      tempPath,
      `${JSON.stringify(this.ownerMetadata(resource, mode, ownerToken), null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );

    const currentOwner = await this.readOwner(directory);
    if (currentOwner?.owner_token !== ownerToken) {
      await rm(tempPath, { force: true });
      return;
    }

    await rename(tempPath, this.ownerPath(directory));
  }

  private async releaseIfCurrent(directory: string, ownerToken: string): Promise<void> {
    const owner = await this.readOwner(directory);
    if (owner?.owner_token !== ownerToken) {
      return;
    }

    const quarantine = `${directory}.released-${ownerToken}`;
    try {
      await rename(directory, quarantine);
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) {
        return;
      }
      throw cause;
    }

    const quarantinedOwner = await this.readOwner(quarantine);
    if (quarantinedOwner?.owner_token !== ownerToken) {
      try {
        await rename(quarantine, directory);
      } catch {
        await rm(quarantine, { recursive: true, force: true });
      }
      return;
    }

    await rm(quarantine, { recursive: true, force: true });
  }

  private async tryRecoverStaleLock(
    resource: string,
    lockDir: string
  ): Promise<void> {
    const owner = await this.readOwner(lockDir);
    if (owner === undefined) {
      this.log("warn", "luna.lock.owner_metadata_corrupt", {
        "luna.resource": resource
      });
      return;
    }

    if (isProcessLive(owner.pid)) {
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

    const quarantine = `${lockDir}.stale-${owner.owner_token ?? acquisitionToken()}`;
    try {
      await rename(lockDir, quarantine);
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) {
        return;
      }
      if (isErrno(cause, "EEXIST")) {
        await rm(quarantine, { recursive: true, force: true });
        return;
      }
      throw cause;
    }

    const quarantinedOwner = await this.readOwner(quarantine);
    if (
      quarantinedOwner === undefined ||
      quarantinedOwner.pid !== owner.pid ||
      quarantinedOwner.run_id !== owner.run_id ||
      quarantinedOwner.owner_token !== owner.owner_token
    ) {
      try {
        await rename(quarantine, lockDir);
      } catch {
        await rm(quarantine, { recursive: true, force: true });
      }
      return;
    }

    await rm(quarantine, { recursive: true, force: true });
    this.log("warn", "luna.lock.stale_recovered", {
      "luna.resource": resource,
      owner_run_id: owner.run_id,
      owner_pid: owner.pid
    });
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    attributes: Record<string, unknown>
  ): void {
    if (this.observability === undefined) {
      return;
    }

    void this.observability
      .emit(
        customEvent({
          ...this.observability.eventContext(level),
          type: event,
          data: sanitizeJsonObject(attributes)
        })
      )
      .catch(() => {
      // Observability is diagnostic here; lock behavior remains authoritative.
      });
  }
}
