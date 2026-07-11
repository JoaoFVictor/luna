import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  rm
} from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalJson } from "../../../core/workflow/definition-digests.js";
import {
  StudioRunLaunchError,
  studioRunLaunchError
} from "../../application/runs/launch-errors.js";
import { RunOpaqueIdSchema } from "../../contracts/runs.js";
import {
  NativeStudioRunTerminalIntentSchema,
  type NativeStudioRunTerminalIntent
} from "../native/run-terminal-intent.js";
import {
  SecureReadFileError,
  openSecureRegularFile
} from "./secure-read-file.js";

const PRIVATE_FILE_MODE = 0o600;
const MAX_TERMINAL_INTENT_BYTES = 9 * 1024 * 1024;

function journalError(message: string, cause?: unknown): Error {
  return studioRunLaunchError(
    "studio_run_dispatch_failed",
    message,
    {},
    cause === undefined ? undefined : { cause }
  );
}

function journalCorruptionError(message: string, cause?: unknown): Error {
  return studioRunLaunchError(
    "studio_run_dispatch_failed",
    message,
    { terminal_journal_corruption: true },
    cause === undefined ? undefined : { cause }
  );
}

export function isNativeStudioRunTerminalJournalCorruption(
  cause: unknown
): boolean {
  return cause instanceof StudioRunLaunchError &&
    cause.details.terminal_journal_corruption === true;
}

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

async function writeExclusive(filePath: string, content: string): Promise<void> {
  const handle = await open(
    filePath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface NativeStudioRunTerminalJournalPort {
  write(intent: NativeStudioRunTerminalIntent): Promise<void>;
  read(runId: string): Promise<NativeStudioRunTerminalIntent | undefined>;
}

export class NativeStudioRunTerminalJournal
  implements NativeStudioRunTerminalJournalPort
{
  readonly #root: string;
  readonly #jobsRoot: string;

  constructor(options: { readonly queueRoot: string }) {
    this.#root = path.resolve(options.queueRoot);
    this.#jobsRoot = path.join(this.#root, "jobs");
  }

  async write(input: NativeStudioRunTerminalIntent): Promise<void> {
    const intent = NativeStudioRunTerminalIntentSchema.parse(input);
    const content = canonicalJson(intent);
    if (Buffer.byteLength(content, "utf8") > MAX_TERMINAL_INTENT_BYTES) {
      throw journalError("Native run terminal intent exceeds its storage limit");
    }
    const directory = await this.physicalJobDirectory(intent.run_id);
    const temporaryPath = path.join(
      directory,
      `.terminal-${randomBytes(8).toString("hex")}`
    );
    const finalPath = path.join(directory, "terminal.json");
    try {
      await writeExclusive(temporaryPath, content);
      try {
        await link(temporaryPath, finalPath);
        await syncDirectory(directory);
        return;
      } catch (cause) {
        if (!isErrno(cause, "EEXIST")) {
          throw cause;
        }
      }
    } catch (cause) {
      throw journalError("Native run terminal intent could not be persisted", cause);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }

    const existing = await this.read(intent.run_id);
    if (existing === undefined || canonicalJson(existing) !== content) {
      throw journalCorruptionError(
        "Native run already has a different terminal intent"
      );
    }
  }

  async read(runId: string): Promise<NativeStudioRunTerminalIntent | undefined> {
    const id = RunOpaqueIdSchema.parse(runId);
    let file;
    try {
      file = await openSecureRegularFile(this.#root, [
        "jobs",
        id,
        "terminal.json"
      ]);
    } catch (cause) {
      if (cause instanceof SecureReadFileError && cause.code === "missing") {
        return undefined;
      }
      if (
        cause instanceof SecureReadFileError &&
        cause.code !== "io_failed"
      ) {
        throw journalCorruptionError(
          "Native run terminal intent is not a secure regular file",
          cause
        );
      }
      throw journalError("Native run terminal intent could not be opened", cause);
    }
    try {
      if (file.size > MAX_TERMINAL_INTENT_BYTES) {
        throw journalCorruptionError(
          "Native run terminal intent exceeds its read limit"
        );
      }
      const content = await file.handle.readFile();
      const final = await file.handle.stat({ bigint: true });
      if (
        final.dev.toString(10) !== file.device ||
        final.ino.toString(10) !== file.inode ||
        final.size !== BigInt(file.size) ||
        BigInt(content.byteLength) !== final.size
      ) {
        throw journalCorruptionError(
          "Native run terminal intent changed while reading"
        );
      }
      let raw: unknown;
      try {
        raw = JSON.parse(content.toString("utf8"));
      } catch (cause) {
        throw journalCorruptionError(
          "Native run terminal intent is not valid JSON",
          cause
        );
      }
      const parsed = NativeStudioRunTerminalIntentSchema.safeParse(raw);
      if (!parsed.success) {
        throw journalCorruptionError("Native run terminal intent is invalid");
      }
      const intent = parsed.data;
      if (intent.run_id !== id) {
        throw journalCorruptionError(
          "Native run terminal intent has the wrong run id"
        );
      }
      return intent;
    } finally {
      await file.handle.close();
    }
  }

  private async physicalJobDirectory(runId: string): Promise<string> {
    const directory = path.join(
      this.#jobsRoot,
      RunOpaqueIdSchema.parse(runId)
    );
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw journalCorruptionError(
        "Native run terminal intent requires a physical job directory"
      );
    }
    return directory;
  }
}
