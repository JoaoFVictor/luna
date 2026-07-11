import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isInsideRoot,
  resolvePathInsideRoot
} from "../../../core/security/path.js";
import { parseAndAssertStudioChangeSet } from "../../application/drafts/change-set.js";
import type { StudioDraftBlobReaderPort } from "../../application/drafts/persistence.js";
import {
  StudioSnapshotCleanupAggregateError,
  StudioSnapshotError,
  type StudioSnapshotVerifiedFile,
  type StudioValidationSnapshot,
  type StudioValidationSnapshotPort
} from "../../application/validation/snapshot.js";
import type {
  StudioBaseFile,
  StudioChangeSet,
  StudioDependency,
  StudioDraftFileChange
} from "../../contracts/drafts.js";
import {
  StudioPathSchema,
  studioPathKey,
  type StudioPath,
  type StudioRoot
} from "../../contracts/paths.js";
import { StudioSnapshotWorkBudget } from "./snapshot-budget.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_FILES = 512;
const MAX_CONFIGURED_BYTES = 256 * 1024 * 1024;
const MAX_CONFIGURED_FILES = 10_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type FileSystemStudioValidationSnapshotOptions = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly blobs: StudioDraftBlobReaderPort;
  readonly temporaryRoot?: string;
  readonly maxSourceFileBytes?: number;
  readonly maxSnapshotBytes?: number;
  readonly maxSnapshotFiles?: number;
  readonly faultInjector?: StudioValidationSnapshotFaultInjector;
};

export type StudioValidationSnapshotFaultStage =
  | "after_snapshot_directory_created"
  | "after_source_resolved"
  | "before_snapshot_cleanup";

export type StudioValidationSnapshotFaultInjector = (
  stage: StudioValidationSnapshotFaultStage,
  context: { readonly file?: StudioPath }
) => Promise<void> | void;

type SnapshotRoots = {
  readonly snapshot: string;
  readonly project: string;
  readonly config: string;
};

type SourceRoots = {
  readonly project: string;
  readonly config: string;
};

function digestBytes(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function configuredByteLimit(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_CONFIGURED_BYTES
  ) {
    throw new StudioSnapshotError(
      "studio_snapshot_source_invalid",
      `${label} must be a positive safe integer no larger than 256 MiB`
    );
  }
  return resolved;
}

function configuredFileLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_SNAPSHOT_FILES;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_CONFIGURED_FILES
  ) {
    throw new StudioSnapshotError(
      "studio_snapshot_source_invalid",
      `maxSnapshotFiles must be a positive safe integer no larger than ${MAX_CONFIGURED_FILES}`
    );
  }
  return resolved;
}

function pathDetails(file: StudioPath): { readonly file: StudioPath } {
  return { file };
}

function sourceConflict(
  file: StudioPath,
  expectedSha256: string | null,
  actualSha256: string | null
): StudioSnapshotError {
  return new StudioSnapshotError(
    "studio_snapshot_source_conflict",
    `Studio source changed after the draft was opened: ${studioPathKey(file)}`,
    {
      details: {
        file,
        expectedSha256,
        actualSha256
      }
    }
  );
}

function sourceRoot(roots: SourceRoots, root: StudioRoot): string {
  return roots[root];
}

function snapshotRoot(roots: SnapshotRoots, root: StudioRoot): string {
  return roots[root];
}

async function removeSnapshot(
  snapshotPath: string,
  faultInjector?: StudioValidationSnapshotFaultInjector
): Promise<void> {
  try {
    await faultInjector?.("before_snapshot_cleanup", {});
    await rm(snapshotPath, { recursive: true, force: true });
  } catch (cause) {
    throw new StudioSnapshotError(
      "studio_snapshot_cleanup_failed",
      "Unable to remove the private Studio validation snapshot",
      { cause }
    );
  }
}

async function createSnapshotRoots(
  temporaryRoot: string,
  faultInjector?: StudioValidationSnapshotFaultInjector
): Promise<SnapshotRoots> {
  let snapshot: string | undefined;
  try {
    await mkdir(temporaryRoot, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE
    });
    snapshot = await mkdtemp(
      path.join(temporaryRoot, "luna-studio-validation-")
    );
    await faultInjector?.("after_snapshot_directory_created", {});
    await chmod(snapshot, PRIVATE_DIRECTORY_MODE);
    const project = path.join(snapshot, "project");
    const config = path.join(snapshot, "config");
    await mkdir(project, { mode: PRIVATE_DIRECTORY_MODE });
    await mkdir(config, { mode: PRIVATE_DIRECTORY_MODE });
    return { snapshot, project, config };
  } catch (cause) {
    if (snapshot !== undefined) {
      try {
        await removeSnapshot(snapshot, faultInjector);
      } catch (cleanupCause) {
        throw new StudioSnapshotCleanupAggregateError(
          "Unable to clean up a partially created validation snapshot",
          cause,
          cleanupCause
        );
      }
    }
    throw new StudioSnapshotError(
      "studio_snapshot_io_failed",
      "Unable to create the private Studio validation snapshot",
      { cause }
    );
  }
}

async function canonicalSourceFile(
  roots: SourceRoots,
  file: StudioPath,
  expectedSha256: string
): Promise<string> {
  const parsed = StudioPathSchema.parse(file);
  const root = sourceRoot(roots, parsed.root);
  try {
    const candidate = await resolvePathInsideRoot(root, parsed.path.split("/"));
    const [rootReal, candidateReal] = await Promise.all([
      realpath(root),
      realpath(candidate)
    ]);
    if (!isInsideRoot(rootReal, candidateReal)) {
      throw new Error("Resolved source is outside its logical root");
    }
    return candidateReal;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw sourceConflict(parsed, expectedSha256, null);
    }
    if (cause instanceof StudioSnapshotError) {
      throw cause;
    }
    throw new StudioSnapshotError(
      "studio_snapshot_path_invalid",
      `Studio source path is not safely readable: ${studioPathKey(parsed)}`,
      { cause, details: pathDetails(parsed) }
    );
  }
}

async function assertOpenedSourceIdentity(
  handle: FileHandle,
  rootReal: string,
  sourcePath: string,
  file: StudioPath
): Promise<void> {
  try {
    const currentPath = await realpath(sourcePath);
    if (!isInsideRoot(rootReal, currentPath)) {
      throw new Error("Opened source resolves outside its logical root");
    }
    const [openedMetadata, pathMetadata] = await Promise.all([
      handle.stat(),
      stat(currentPath)
    ]);
    if (
      openedMetadata.dev !== pathMetadata.dev ||
      openedMetadata.ino !== pathMetadata.ino
    ) {
      throw new Error("Opened source identity changed during validation");
    }
  } catch (cause) {
    throw new StudioSnapshotError(
      "studio_snapshot_path_invalid",
      `Studio source path changed while it was being opened: ${studioPathKey(file)}`,
      { cause, details: pathDetails(file) }
    );
  }
}

async function sourceEntryExists(
  roots: SourceRoots,
  file: StudioPath
): Promise<boolean> {
  const parsed = StudioPathSchema.parse(file);
  const root = sourceRoot(roots, parsed.root);
  let candidate: string;
  try {
    candidate = await resolvePathInsideRoot(root, parsed.path.split("/"));
  } catch (cause) {
    throw new StudioSnapshotError(
      "studio_snapshot_path_invalid",
      `Studio source path is not safely readable: ${studioPathKey(parsed)}`,
      { cause, details: pathDetails(parsed) }
    );
  }

  try {
    await lstat(candidate);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw new StudioSnapshotError(
      "studio_snapshot_io_failed",
      `Unable to inspect Studio source: ${studioPathKey(parsed)}`,
      { cause, details: pathDetails(parsed) }
    );
  }
}

async function readBoundedSourceFile(
  roots: SourceRoots,
  file: StudioPath,
  maxBytes: number,
  expectedSha256: string,
  budget: StudioSnapshotWorkBudget,
  faultInjector?: StudioValidationSnapshotFaultInjector
): Promise<Buffer> {
  const sourcePath = await canonicalSourceFile(
    roots,
    file,
    expectedSha256
  );
  await faultInjector?.("after_source_resolved", { file });
  let handle;
  try {
    handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw sourceConflict(file, expectedSha256, null);
    }
    throw new StudioSnapshotError(
      "studio_snapshot_source_invalid",
      `Studio source is not a regular readable file: ${studioPathKey(file)}`,
      { cause, details: pathDetails(file) }
    );
  }

  try {
    await assertOpenedSourceIdentity(
      handle,
      sourceRoot(roots, file.root),
      sourcePath,
      file
    );
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new StudioSnapshotError(
        "studio_snapshot_source_invalid",
        `Studio source is not a regular file: ${studioPathKey(file)}`,
        { details: pathDetails(file) }
      );
    }
    if (metadata.size > maxBytes) {
      throw new StudioSnapshotError(
        "studio_snapshot_source_too_large",
        `Studio source exceeds its validation size limit: ${studioPathKey(file)}`,
        {
          details: {
            file,
            actualBytes: metadata.size,
            maxBytes
          }
        }
      );
    }
    budget.assertFits(file, metadata.size, "source_read");

    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = maxBytes + 1 - total;
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        const result = Buffer.concat(chunks, total);
        await assertOpenedSourceIdentity(
          handle,
          sourceRoot(roots, file.root),
          sourcePath,
          file
        );
        try {
          UTF8_DECODER.decode(result);
        } catch (cause) {
          throw new StudioSnapshotError(
            "studio_snapshot_source_invalid",
            `Studio source is not valid UTF-8: ${studioPathKey(file)}`,
            { cause, details: pathDetails(file) }
          );
        }
        return result;
      }
      total += bytesRead;
      if (total > maxBytes) {
        throw new StudioSnapshotError(
          "studio_snapshot_source_too_large",
          `Studio source exceeds its validation size limit: ${studioPathKey(file)}`,
          { details: { file, actualBytes: total, maxBytes } }
        );
      }
      budget.account(file, bytesRead, "source_read");
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

async function writeSnapshotFile(
  roots: SnapshotRoots,
  file: StudioPath,
  content: Uint8Array
): Promise<void> {
  const destination = path.join(
    snapshotRoot(roots, file.root),
    ...file.path.split("/")
  );
  try {
    await mkdir(path.dirname(destination), {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE
    });
    await writeFile(destination, content, {
      flag: "wx",
      mode: PRIVATE_FILE_MODE
    });
    await chmod(destination, PRIVATE_FILE_MODE);
  } catch (cause) {
    throw new StudioSnapshotError(
      "studio_snapshot_io_failed",
      `Unable to materialize Studio snapshot file: ${studioPathKey(file)}`,
      { cause, details: pathDetails(file) }
    );
  }
}

async function canonicalSourceRoot(root: string, label: string): Promise<string> {
  try {
    const resolved = await realpath(root);
    const metadata = await stat(resolved);
    if (!metadata.isDirectory()) {
      throw new Error(`${label} is not a directory`);
    }
    return resolved;
  } catch (cause) {
    throw new StudioSnapshotError(
      "studio_snapshot_source_invalid",
      `${label} is not an accessible directory`,
      { cause }
    );
  }
}

export class FileSystemStudioValidationSnapshot
  implements StudioValidationSnapshotPort
{
  private readonly sourceRoots: SourceRoots;
  private readonly blobs: StudioDraftBlobReaderPort;
  private readonly temporaryRoot: string;
  private readonly maxSourceFileBytes: number;
  private readonly maxSnapshotBytes: number;
  private readonly maxSnapshotFiles: number;
  private readonly faultInjector: StudioValidationSnapshotFaultInjector | undefined;

  constructor(options: FileSystemStudioValidationSnapshotOptions) {
    if (options.projectRoot.trim() === "" || options.configRoot.trim() === "") {
      throw new StudioSnapshotError(
        "studio_snapshot_source_invalid",
        "Studio project and config roots cannot be empty"
      );
    }
    this.sourceRoots = {
      project: path.resolve(options.projectRoot),
      config: path.resolve(options.configRoot)
    };
    this.blobs = options.blobs;
    this.temporaryRoot = path.resolve(options.temporaryRoot ?? tmpdir());
    this.maxSourceFileBytes = configuredByteLimit(
      options.maxSourceFileBytes,
      DEFAULT_MAX_SOURCE_FILE_BYTES,
      "maxSourceFileBytes"
    );
    this.maxSnapshotBytes = configuredByteLimit(
      options.maxSnapshotBytes,
      DEFAULT_MAX_SNAPSHOT_BYTES,
      "maxSnapshotBytes"
    );
    this.maxSnapshotFiles = configuredFileLimit(options.maxSnapshotFiles);
    this.faultInjector = options.faultInjector;
  }

  async create(input: StudioChangeSet): Promise<StudioValidationSnapshot> {
    const changeSet = parseAndAssertStudioChangeSet(input);
    const [project, config] = await Promise.all([
      canonicalSourceRoot(this.sourceRoots.project, "Studio project root"),
      canonicalSourceRoot(this.sourceRoots.config, "Studio config root")
    ]);
    const physicalSourceRoots = { project, config };
    const budget = new StudioSnapshotWorkBudget(
      this.maxSnapshotBytes,
      this.maxSnapshotFiles,
      changeSet.base_files.length + changeSet.dependencies.length
    );
    const roots = await createSnapshotRoots(
      this.temporaryRoot,
      this.faultInjector
    );

    try {
      const changes = new Map(
        changeSet.changes.map((change) => [studioPathKey(change.file), change])
      );
      const verifiedFiles: StudioSnapshotVerifiedFile[] = [];

      for (const baseFile of changeSet.base_files) {
        await this.materializeBaseFile(
          roots,
          physicalSourceRoots,
          changeSet,
          baseFile,
          changes.get(studioPathKey(baseFile.file)),
          budget
        );
        verifiedFiles.push({
          file: baseFile.file,
          role: "base",
          sha256: baseFile.sha256
        });
      }

      for (const dependency of changeSet.dependencies) {
        await this.materializeDependency(
          roots,
          physicalSourceRoots,
          dependency,
          budget
        );
        verifiedFiles.push({
          file: dependency.file,
          role: "dependency",
          sha256: dependency.sha256
        });
      }

      let disposed = false;
      const faultInjector = this.faultInjector;
      return {
        projectRoot: roots.project,
        configRoot: roots.config,
        verifiedFiles,
        async dispose(): Promise<void> {
          if (disposed) {
            return;
          }
          await removeSnapshot(roots.snapshot, faultInjector);
          disposed = true;
        }
      };
    } catch (cause) {
      try {
        await removeSnapshot(roots.snapshot, this.faultInjector);
      } catch (cleanupCause) {
        throw new StudioSnapshotCleanupAggregateError(
          "Studio snapshot failed and its private files could not be removed",
          cause,
          cleanupCause
        );
      }
      throw cause;
    }
  }

  private async materializeBaseFile(
    roots: SnapshotRoots,
    sourceRoots: SourceRoots,
    changeSet: StudioChangeSet,
    baseFile: StudioBaseFile,
    change: StudioDraftFileChange | undefined,
    budget: StudioSnapshotWorkBudget
  ): Promise<void> {
    if (baseFile.sha256 === null) {
      if (await sourceEntryExists(sourceRoots, baseFile.file)) {
        throw sourceConflict(baseFile.file, null, "sha256:present");
      }
    } else {
      const current = await readBoundedSourceFile(
        sourceRoots,
        baseFile.file,
        this.maxSourceFileBytes,
        baseFile.sha256,
        budget,
        this.faultInjector
      );
      const currentDigest = digestBytes(current);
      if (currentDigest !== baseFile.sha256) {
        throw sourceConflict(baseFile.file, baseFile.sha256, currentDigest);
      }
    }

    if (change?.action === "delete") {
      return;
    }

    const contentRef =
      change?.action === "write" ? change.content_ref : baseFile.content_ref;
    if (contentRef === null) {
      return;
    }
    const remainingWorkBytes = budget.remainingBytes(
      baseFile.file,
      "blob_read"
    );
    const maxBlobReadBytes = Math.min(
      this.maxSourceFileBytes,
      remainingWorkBytes
    );
    let content: string;
    try {
      content = await this.blobs.getBlob(changeSet.draft_id, contentRef, {
        maxBytes: maxBlobReadBytes
      });
    } catch (cause) {
      if (
        maxBlobReadBytes < this.maxSourceFileBytes &&
        (cause as { readonly code?: unknown }).code === "studio_blob_too_large"
      ) {
        budget.assertFits(baseFile.file, maxBlobReadBytes + 1, "blob_read");
      }
      throw new StudioSnapshotError(
        "studio_snapshot_blob_invalid",
        `Studio draft blob is unavailable: ${studioPathKey(baseFile.file)}`,
        { cause, details: pathDetails(baseFile.file) }
      );
    }
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > this.maxSourceFileBytes) {
      throw new StudioSnapshotError(
        "studio_snapshot_source_too_large",
        `Studio draft source exceeds its validation size limit: ${studioPathKey(baseFile.file)}`,
        {
          details: {
            file: baseFile.file,
            actualBytes: contentBytes,
            maxBytes: this.maxSourceFileBytes
          }
        }
      );
    }
    budget.account(baseFile.file, contentBytes, "blob_read");
    const bytes = Buffer.from(content, "utf8");
    if (digestBytes(bytes) !== contentRef) {
      throw new StudioSnapshotError(
        "studio_snapshot_blob_invalid",
        `Studio draft blob does not match its content address: ${studioPathKey(baseFile.file)}`,
        { details: pathDetails(baseFile.file) }
      );
    }
    budget.account(baseFile.file, bytes.byteLength, "materialize");
    await writeSnapshotFile(roots, baseFile.file, bytes);
  }

  private async materializeDependency(
    roots: SnapshotRoots,
    sourceRoots: SourceRoots,
    dependency: StudioDependency,
    budget: StudioSnapshotWorkBudget
  ): Promise<void> {
    const content = await readBoundedSourceFile(
      sourceRoots,
      dependency.file,
      this.maxSourceFileBytes,
      dependency.sha256,
      budget,
      this.faultInjector
    );
    const actualDigest = digestBytes(content);
    if (actualDigest !== dependency.sha256) {
      throw sourceConflict(
        dependency.file,
        dependency.sha256,
        actualDigest
      );
    }
    budget.account(dependency.file, content.byteLength, "materialize");
    await writeSnapshotFile(roots, dependency.file, content);
  }
}
