import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

export type AtomicWriteCommitState =
  | "not_committed"
  | "commit_ambiguous";

export type AtomicWriteFaultStage =
  | "after_temp_file_created"
  | "after_file_synced"
  | "after_rename"
  | "after_directory_synced";

export interface AtomicWriteHooks {
  /** Audit callbacks receive no mutable path and cannot fail the write. */
  onTempFileCreated?: () => unknown;
  onFileSynced?: () => unknown;
  onDirectorySynced?: () => unknown;
}

export type AtomicWriteContent = string | Uint8Array;

export type AtomicWriteOptions = {
  readonly mode: number;
  readonly errorCode: string;
  readonly errorLabel: string;
  readonly commitAmbiguousErrorCode?: string;
  readonly hooks?: AtomicWriteHooks;
  /** Explicit test seam. Unlike audit hooks, injected failures affect outcome. */
  readonly faultInjector?: (
    stage: AtomicWriteFaultStage
  ) => Promise<void> | void;
};

export type AtomicWriteError = Error & {
  readonly code: string;
  readonly commitState: AtomicWriteCommitState;
};

function atomicWriteError(
  cause: unknown,
  options: AtomicWriteOptions,
  commitState: AtomicWriteCommitState,
  cleanupCause?: unknown
): AtomicWriteError {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  const errorCause =
    cleanupCause === undefined ? cause : { write: cause, cleanup: cleanupCause };
  const error = new Error(`${options.errorLabel} failed${detail}`, {
    cause: errorCause
  }) as AtomicWriteError;
  Object.defineProperties(error, {
    code: {
      value:
        commitState === "commit_ambiguous"
          ? (options.commitAmbiguousErrorCode ?? options.errorCode)
          : options.errorCode,
      enumerable: true
    },
    commitState: { value: commitState, enumerable: true }
  });

  return error;
}

function notifyAudit(hook: (() => unknown) | undefined): void {
  if (hook === undefined) {
    return;
  }
  try {
    const result = hook();
    if (
      typeof result === "object" &&
      result !== null &&
      "then" in result &&
      typeof result.then === "function"
    ) {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Observability is deliberately unable to alter persistence semantics.
  }
}

function tempPathFor(targetPath: string): string {
  const directory = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  const unique = `${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}`;

  return path.join(directory, `.${basename}.${unique}.tmp`);
}

export async function writeFileAtomically(
  targetPath: string,
  content: AtomicWriteContent,
  options: AtomicWriteOptions
): Promise<void> {
  const tempPath = tempPathFor(targetPath);
  const hooks = options.hooks ?? {};
  let tempCreated = false;
  let renamed = false;

  try {
    const file = await open(tempPath, "wx", options.mode);
    tempCreated = true;
    notifyAudit(hooks.onTempFileCreated);
    await options.faultInjector?.("after_temp_file_created");

    try {
      await file.writeFile(content);
      // Apply the exact mode through the open descriptor. Chmodding the target
      // after rename would introduce a symlink/target TOCTOU window.
      await file.chmod(options.mode);
      await file.sync();
      notifyAudit(hooks.onFileSynced);
      await options.faultInjector?.("after_file_synced");
    } finally {
      await file.close();
    }

    await rename(tempPath, targetPath);
    tempCreated = false;
    renamed = true;
    await options.faultInjector?.("after_rename");

    const directory = await open(path.dirname(targetPath), "r");
    try {
      await directory.sync();
      notifyAudit(hooks.onDirectorySynced);
      await options.faultInjector?.("after_directory_synced");
    } finally {
      await directory.close();
    }
  } catch (cause) {
    let cleanupCause: unknown;

    if (tempCreated) {
      try {
        await rm(tempPath, { force: true });
      } catch (error) {
        cleanupCause = error;
      }
    }

    throw atomicWriteError(
      cause,
      options,
      renamed ? "commit_ambiguous" : "not_committed",
      cleanupCause
    );
  }
}
