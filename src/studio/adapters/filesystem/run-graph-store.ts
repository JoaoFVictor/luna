import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  rename,
  rm
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../../../core/workflow/definition-digests.js";
import {
  RunGraphSnapshotError,
  StoredRunGraphOutcomeSchema,
  StoredRunGraphSnapshotSchema,
  runGraphSnapshotIdentitiesEqual,
  type RunGraphSnapshotReadResult,
  type RunGraphSnapshotStorePort,
  type StoredRunGraphOutcome,
  type StoredRunGraphSnapshot
} from "../../application/runs/graph-snapshot.js";
import { RunGraphSnapshotHandleSchema } from "../../contracts/runs.js";
import {
  SecureReadFileError,
  openSecureRegularFile
} from "./secure-read-file.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
export const MAX_STORED_RUN_GRAPH_BYTES = 32 * 1024 * 1024;
export const MAX_STORED_RUN_OUTCOME_BYTES = 8 * 1024 * 1024;

function isErrno(cause: unknown, ...codes: readonly string[]): boolean {
  return codes.includes((cause as NodeJS.ErrnoException).code ?? "");
}

function writeError(message: string): RunGraphSnapshotError {
  return new RunGraphSnapshotError("run_graph_store_write_failed", message);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw writeError("Run graph storage must use physical directories");
  }
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await handle.chmod(PRIVATE_DIRECTORY_MODE);
    await handle.sync();
  } finally {
    await handle.close();
  }
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

async function writeExclusiveFile(filePath: string, content: string): Promise<void> {
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

function validateSize(content: string, limit: number, label: string): void {
  if (Buffer.byteLength(content, "utf8") > limit) {
    throw writeError(`${label} exceeds its durable storage limit`);
  }
}

export type FilesystemRunGraphStoreOptions = {
  readonly root: string;
};

export class FilesystemRunGraphStore implements RunGraphSnapshotStorePort {
  readonly #root: string;
  readonly #snapshotsRoot: string;

  constructor(options: FilesystemRunGraphStoreOptions) {
    this.#root = path.resolve(options.root);
    this.#snapshotsRoot = path.join(this.#root, "snapshots");
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.#root);
    await ensurePrivateDirectory(this.#snapshotsRoot);
  }

  async writeGraph(input: StoredRunGraphSnapshot): Promise<void> {
    let snapshot: StoredRunGraphSnapshot;
    try {
      snapshot = StoredRunGraphSnapshotSchema.parse(input);
    } catch {
      throw writeError("Run graph snapshot is invalid");
    }
    const content = canonicalJson(snapshot);
    validateSize(content, MAX_STORED_RUN_GRAPH_BYTES, "Run graph snapshot");
    await this.initialize();

    const finalDirectory = this.snapshotDirectory(
      snapshot.identity.graph_snapshot_handle
    );
    const stagingDirectory = path.join(
      this.#snapshotsRoot,
      `.creating-${snapshot.identity.graph_snapshot_handle}-${randomBytes(8).toString("hex")}`
    );
    try {
      await mkdir(stagingDirectory, {
        mode: PRIVATE_DIRECTORY_MODE
      });
      await writeExclusiveFile(path.join(stagingDirectory, "graph.json"), content);
      await syncDirectory(stagingDirectory);
      try {
        await rename(stagingDirectory, finalDirectory);
        await syncDirectory(this.#snapshotsRoot);
        return;
      } catch (cause) {
        if (!isErrno(cause, "EEXIST", "ENOTEMPTY")) {
          throw cause;
        }
      }
    } catch {
      throw writeError("Run graph snapshot could not be durably stored");
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(
        () => undefined
      );
    }

    const existing = await this.readGraph(snapshot.identity.graph_snapshot_handle);
    if (
      existing.kind !== "available" ||
      canonicalJson(existing.value) !== content
    ) {
      throw writeError("Run graph handle already contains different content");
    }
  }

  async writeOutcome(input: StoredRunGraphOutcome): Promise<void> {
    let outcome: StoredRunGraphOutcome;
    try {
      outcome = StoredRunGraphOutcomeSchema.parse(input);
    } catch {
      throw writeError("Run graph outcome is invalid");
    }
    const content = canonicalJson(outcome);
    validateSize(content, MAX_STORED_RUN_OUTCOME_BYTES, "Run graph outcome");

    const graph = await this.readGraph(outcome.identity.graph_snapshot_handle);
    if (
      graph.kind !== "available" ||
      graph.value.graph_hash !== outcome.graph_hash ||
      !runGraphSnapshotIdentitiesEqual(graph.value.identity, outcome.identity)
    ) {
      throw writeError("Run graph outcome does not match a stored graph");
    }
    const graphIds = new Set(graph.value.graph.nodes.map((node) => node.id));
    if (outcome.nodes.some((node) => !graphIds.has(node.node_id))) {
      throw writeError("Run graph outcome references an unknown node");
    }

    const directory = this.snapshotDirectory(
      outcome.identity.graph_snapshot_handle
    );
    const temporaryPath = path.join(
      directory,
      `.outcome-${randomBytes(8).toString("hex")}`
    );
    const finalPath = path.join(directory, "outcome.json");
    try {
      await writeExclusiveFile(temporaryPath, content);
      try {
        await link(temporaryPath, finalPath);
        await syncDirectory(directory);
        return;
      } catch (cause) {
        if (!isErrno(cause, "EEXIST")) {
          throw cause;
        }
      }
    } catch {
      throw writeError("Run graph outcome could not be durably stored");
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }

    const existing = await this.readOutcome(outcome.identity.graph_snapshot_handle);
    if (
      existing.kind !== "available" ||
      canonicalJson(existing.value) !== content
    ) {
      throw writeError("Run graph outcome already contains different content");
    }
  }

  async readGraph(
    handle: string
  ): Promise<RunGraphSnapshotReadResult<StoredRunGraphSnapshot>> {
    return this.readStored(
      handle,
      "graph.json",
      MAX_STORED_RUN_GRAPH_BYTES,
      (raw) => StoredRunGraphSnapshotSchema.parse(raw)
    );
  }

  async readOutcome(
    handle: string
  ): Promise<RunGraphSnapshotReadResult<StoredRunGraphOutcome>> {
    return this.readStored(
      handle,
      "outcome.json",
      MAX_STORED_RUN_OUTCOME_BYTES,
      (raw) => StoredRunGraphOutcomeSchema.parse(raw)
    );
  }

  private snapshotDirectory(handle: string): string {
    return path.join(this.#snapshotsRoot, RunGraphSnapshotHandleSchema.parse(handle));
  }

  private async readStored<T extends { identity: {
    graph_snapshot_handle: string;
  } }>(
    handle: string,
    fileName: "graph.json" | "outcome.json",
    maxBytes: number,
    parse: (raw: unknown) => T
  ): Promise<RunGraphSnapshotReadResult<T>> {
    const parsedHandle = RunGraphSnapshotHandleSchema.safeParse(handle);
    if (!parsedHandle.success) {
      return { kind: "corrupt" };
    }

    try {
      const file = await openSecureRegularFile(this.#snapshotsRoot, [
        parsedHandle.data,
        fileName
      ]);
      try {
        if (file.size > maxBytes) {
          return { kind: "corrupt" };
        }
        const content = await file.handle.readFile();
        const final = await file.handle.stat({ bigint: true });
        if (
          final.dev.toString(10) !== file.device ||
          final.ino.toString(10) !== file.inode ||
          final.size !== BigInt(file.size) ||
          final.mtimeNs.toString(10) !== file.modified_nanoseconds ||
          final.ctimeNs.toString(10) !== file.changed_nanoseconds ||
          content.byteLength !== file.size
        ) {
          return { kind: "corrupt" };
        }
        let raw: unknown;
        try {
          raw = JSON.parse(content.toString("utf8"));
        } catch {
          return { kind: "corrupt" };
        }
        let value: T;
        try {
          value = parse(raw);
        } catch {
          return { kind: "corrupt" };
        }
        if (value.identity.graph_snapshot_handle !== parsedHandle.data) {
          return { kind: "corrupt" };
        }
        return { kind: "available", value };
      } finally {
        await file.handle.close();
      }
    } catch (cause) {
      if (cause instanceof SecureReadFileError) {
        if (cause.code === "missing") {
          return { kind: "missing" };
        }
        if (
          cause.code === "security_violation" ||
          cause.code === "not_regular_file" ||
          cause.code === "size_unsupported"
        ) {
          return { kind: "corrupt" };
        }
      }
      return { kind: "unavailable" };
    }
  }
}
