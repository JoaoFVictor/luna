import {
  lstat,
  link,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { isErrno } from "./lock-file-system.js";
import {
  inspectProcess,
  parseProcessIdentity,
  type LinuxProcProcessIdentity
} from "./lock-process-identity.js";

export type LockMode = "exclusive";

export type LockOwnerMetadata = {
  resource: string;
  mode: LockMode;
  run_id: string;
  runtime_run_id?: string;
  owner_token?: string;
  process_identity?: LinuxProcProcessIdentity;
  pid: number;
  heartbeat_at: string;
};

const OWNER_CLAIM_PATTERN = /^owner\.[a-f0-9]{32}\.claim$/u;

function ownerPath(directory: string): string {
  return path.join(directory, "owner.json");
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
    (parsed as LockOwnerMetadata).pid < 1 ||
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

  const rawProcessIdentity = (parsed as LockOwnerMetadata).process_identity;
  const processIdentity = rawProcessIdentity === undefined
    ? undefined
    : parseProcessIdentity(rawProcessIdentity);
  if (rawProcessIdentity !== undefined && processIdentity === undefined) {
    return undefined;
  }

  return {
    resource: (parsed as LockOwnerMetadata).resource,
    mode: "exclusive",
    run_id: (parsed as LockOwnerMetadata).run_id,
    ...(runtimeRunId === undefined ? {} : { runtime_run_id: runtimeRunId }),
    ...(ownerToken === undefined ? {} : { owner_token: ownerToken }),
    ...(processIdentity === undefined ? {} : { process_identity: processIdentity }),
    pid: (parsed as LockOwnerMetadata).pid,
    heartbeat_at: (parsed as LockOwnerMetadata).heartbeat_at
  };
}

export async function readLockOwner(
  directory: string
): Promise<LockOwnerMetadata | undefined> {
  try {
    return parseOwnerMetadata(await readFile(ownerPath(directory), "utf8"));
  } catch {
    return undefined;
  }
}

export async function readLockOwnerForRelease(
  directory: string
): Promise<LockOwnerMetadata | undefined> {
  try {
    return parseOwnerMetadata(await readFile(ownerPath(directory), "utf8"));
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) {
      return undefined;
    }
    throw cause;
  }
}

export async function lockOwnerFileExists(directory: string): Promise<boolean> {
  try {
    await lstat(ownerPath(directory));
    return true;
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) {
      return false;
    }
    throw cause;
  }
}

export function isOwnerClaimEntry(entry: string): boolean {
  return OWNER_CLAIM_PATTERN.test(entry);
}

export class RunLockOwnerPublisher {
  private localProcessIdentity: LinuxProcProcessIdentity | undefined;

  constructor(
    private readonly runId: string,
    private readonly runtimeRunId: string | undefined
  ) {}

  async publish(
    directory: string,
    resource: string,
    mode: LockMode,
    ownerToken: string
  ): Promise<void> {
    const claimPath = path.join(directory, `owner.${ownerToken}.claim`);
    await writeFile(
      claimPath,
      `${JSON.stringify(
        await this.ownerMetadata(resource, mode, ownerToken),
        null,
        2
      )}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" }
    );
    try {
      await link(claimPath, ownerPath(directory));
    } finally {
      try {
        await rm(claimPath, { force: true });
      } catch {
        // A published owner remains authoritative; release removes leftovers.
      }
    }
  }

  async refreshIfCurrent(
    directory: string,
    resource: string,
    mode: LockMode,
    ownerToken: string
  ): Promise<void> {
    const owner = await readLockOwner(directory);
    if (owner?.owner_token !== ownerToken) {
      return;
    }

    const tempPath = path.join(directory, `owner.${ownerToken}.tmp`);
    await writeFile(
      tempPath,
      `${JSON.stringify(
        await this.ownerMetadata(resource, mode, ownerToken),
        null,
        2
      )}\n`,
      { encoding: "utf8", mode: 0o600 }
    );

    const currentOwner = await readLockOwner(directory);
    if (currentOwner?.owner_token !== ownerToken) {
      await rm(tempPath, { force: true });
      return;
    }

    await rename(tempPath, ownerPath(directory));
  }

  private async ownerMetadata(
    resource: string,
    mode: LockMode,
    ownerToken: string
  ): Promise<LockOwnerMetadata> {
    const processIdentity = await this.resolveLocalProcessIdentity();
    return {
      resource,
      mode,
      run_id: this.runId,
      ...(this.runtimeRunId === undefined
        ? {}
        : { runtime_run_id: this.runtimeRunId }),
      owner_token: ownerToken,
      ...(processIdentity === undefined
        ? {}
        : { process_identity: processIdentity }),
      pid: process.pid,
      heartbeat_at: new Date().toISOString()
    };
  }

  private async resolveLocalProcessIdentity(): Promise<
    LinuxProcProcessIdentity | undefined
  > {
    if (this.localProcessIdentity !== undefined) {
      return this.localProcessIdentity;
    }
    const inspection = await inspectProcess(process.pid);
    if (inspection.identity !== undefined) {
      this.localProcessIdentity = inspection.identity;
    }
    return inspection.identity;
  }
}
