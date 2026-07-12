import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  rm
} from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { RunOpaqueIdSchema } from "../../contracts/runs.js";
import {
  SecureReadFileError,
  openSecureRegularFile
} from "./secure-read-file.js";

const PRIVATE_FILE_MODE = 0o600;

type JournalErrorFactory = (message: string, cause?: unknown) => Error;

export type ImmutableJobJournalOptions = {
  readonly queueRoot: string;
  readonly fileName: string;
  readonly temporaryPrefix: string;
  readonly maximumBytes: number;
  readonly label: string;
  readonly failure: JournalErrorFactory;
  readonly corruption: JournalErrorFactory;
};

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

/**
 * Stores one immutable, create-if-absent document inside a durable run job.
 * Hard-link publication makes concurrent writers converge on exact content,
 * while secure reads pin and revalidate the opened inode.
 */
export class ImmutableJobJournal {
  readonly #root: string;
  readonly #jobsRoot: string;
  readonly #options: ImmutableJobJournalOptions;

  constructor(options: ImmutableJobJournalOptions) {
    this.#options = options;
    this.#root = path.resolve(options.queueRoot);
    this.#jobsRoot = path.join(this.#root, "jobs");
  }

  async write(runId: string, content: string): Promise<void> {
    const id = RunOpaqueIdSchema.parse(runId);
    if (Buffer.byteLength(content, "utf8") > this.#options.maximumBytes) {
      throw this.#options.failure(
        `${this.#options.label} exceeds its storage limit`
      );
    }
    const directory = await this.physicalJobDirectory(id);
    const temporaryPath = path.join(
      directory,
      `.${this.#options.temporaryPrefix}-${randomBytes(8).toString("hex")}`
    );
    const finalPath = path.join(directory, this.#options.fileName);
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
      throw this.#options.failure(
        `${this.#options.label} could not be persisted`,
        cause
      );
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }

    const existing = await this.read(id);
    if (existing === undefined || existing !== content) {
      throw this.#options.corruption(
        `Native run already has a different ${this.#options.label.toLowerCase()}`
      );
    }
  }

  async read(runId: string): Promise<string | undefined> {
    const id = RunOpaqueIdSchema.parse(runId);
    let file;
    try {
      file = await openSecureRegularFile(this.#root, [
        "jobs",
        id,
        this.#options.fileName
      ]);
    } catch (cause) {
      if (cause instanceof SecureReadFileError && cause.code === "missing") {
        return undefined;
      }
      if (cause instanceof SecureReadFileError && cause.code !== "io_failed") {
        throw this.#options.corruption(
          `${this.#options.label} is not a secure regular file`,
          cause
        );
      }
      throw this.#options.failure(
        `${this.#options.label} could not be opened`,
        cause
      );
    }
    try {
      if (file.size > this.#options.maximumBytes) {
        throw this.#options.corruption(
          `${this.#options.label} exceeds its read limit`
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
        throw this.#options.corruption(
          `${this.#options.label} changed while reading`
        );
      }
      return content.toString("utf8");
    } finally {
      await file.handle.close();
    }
  }

  private async physicalJobDirectory(runId: string): Promise<string> {
    const directory = path.join(this.#jobsRoot, runId);
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch (cause) {
      throw this.#options.failure(
        `${this.#options.label} requires an existing job directory`,
        cause
      );
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw this.#options.corruption(
        `${this.#options.label} requires a physical job directory`
      );
    }
    return directory;
  }
}
