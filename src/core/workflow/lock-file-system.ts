import { randomBytes } from "node:crypto";
import { rename } from "node:fs/promises";

export function isErrno(cause: unknown, code: string): boolean {
  return (cause as NodeJS.ErrnoException).code === code;
}

export function acquisitionToken(): string {
  return randomBytes(16).toString("hex");
}

export async function restoreQuarantineBestEffort(
  quarantine: string,
  lockDir: string
): Promise<void> {
  try {
    await rename(quarantine, lockDir);
  } catch {
    // Preserve ambiguous quarantine evidence instead of deleting or
    // overwriting a lock that appeared during recovery.
  }
}
