import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  rm
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertSafeSegment } from "../../../core/security/path.js";
import { readWorkflowDefinitionReferences } from "../../../core/workflow/definition-references.js";
import { studioRunValueDigest } from "../../application/runs/launch-digests.js";
import {
  StudioRunLaunchError,
  studioRunLaunchError
} from "../../application/runs/launch-errors.js";
import {
  SecureReadFileError,
  openSecureRegularFile
} from "../filesystem/secure-read-file.js";
import {
  NATIVE_STUDIO_RUN_SNAPSHOT_LIMITS,
  NativeStudioRunSnapshotManifestSchema,
  type NativeStudioRunSnapshot,
  type NativeStudioRunSnapshotFile,
  type NativeStudioRunSnapshotFileManifest,
  type NativeStudioRunSnapshotManifest
} from "./run-snapshot-contracts.js";

type SnapshotRoot = "project" | "config";
type CaptureBudget = { files: number; directories: number; bytes: number };

function snapshotFailure(message: string, cause?: unknown): Error {
  return studioRunLaunchError(
    "studio_run_plan_resolution_invalid",
    message,
    {},
    cause === undefined ? undefined : { cause }
  );
}

function snapshotIntegrityFailure(message: string, cause?: unknown): Error {
  return studioRunLaunchError(
    "studio_run_plan_resolution_invalid",
    message,
    { snapshot_integrity: true },
    cause === undefined ? undefined : { cause }
  );
}

export function isNativeStudioRunSnapshotIntegrityFailure(
  cause: unknown
): boolean {
  return cause instanceof StudioRunLaunchError &&
    cause.details.snapshot_integrity === true;
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isDeterministicFilesystemFailure(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function snapshotContentFailure(
  durable: boolean,
  message: string,
  cause?: unknown
): Error {
  return durable
    ? snapshotIntegrityFailure(message, cause)
    : snapshotFailure(message, cause);
}

function accountDirectory(budget: CaptureBudget, durable = false): void {
  budget.directories += 1;
  if (budget.directories > NATIVE_STUDIO_RUN_SNAPSHOT_LIMITS.maxDirectories) {
    throw snapshotContentFailure(
      durable,
      "Native run snapshot contains too many directories"
    );
  }
}

function accountFile(
  budget: CaptureBudget,
  bytes: number,
  durable = false
): void {
  budget.files += 1;
  budget.bytes += bytes;
  if (
    budget.files > NATIVE_STUDIO_RUN_SNAPSHOT_LIMITS.maxFiles ||
    budget.bytes > NATIVE_STUDIO_RUN_SNAPSHOT_LIMITS.maxTotalBytes
  ) {
    throw snapshotContentFailure(
      durable,
      "Native run snapshot exceeds its storage budget"
    );
  }
}

async function captureFile(
  root: string,
  rootKind: SnapshotRoot,
  segments: readonly string[],
  budget: CaptureBudget,
  durable = false
): Promise<NativeStudioRunSnapshotFile> {
  let opened;
  try {
    opened = await openSecureRegularFile(root, segments);
  } catch (cause) {
    if (
      durable &&
      cause instanceof SecureReadFileError &&
      cause.code !== "io_failed"
    ) {
      throw snapshotIntegrityFailure(
        "Durable native run snapshot contains an invalid file",
        cause
      );
    }
    throw cause;
  }
  try {
    if (opened.size > NATIVE_STUDIO_RUN_SNAPSHOT_LIMITS.maxFileBytes) {
      throw snapshotContentFailure(
        durable,
        "Native run snapshot file exceeds its size limit"
      );
    }
    const content = await opened.handle.readFile();
    const final = await opened.handle.stat({ bigint: true });
    if (
      !final.isFile() ||
      final.dev.toString(10) !== opened.device ||
      final.ino.toString(10) !== opened.inode ||
      final.mtimeNs.toString(10) !== opened.modified_nanoseconds ||
      Number(final.size) !== opened.size ||
      content.byteLength !== opened.size
    ) {
      throw snapshotContentFailure(
        durable,
        "Native run snapshot source changed while reading"
      );
    }
    accountFile(budget, content.byteLength, durable);
    return {
      root: rootKind,
      path: segments.join("/"),
      sha256: digest(content),
      mode: Number(final.mode & 0o777n),
      bytes: content.byteLength,
      content
    };
  } finally {
    await opened.handle.close();
  }
}

async function captureTree(
  root: string,
  rootKind: SnapshotRoot,
  prefix: readonly string[],
  budget: CaptureBudget,
  files: Map<string, NativeStudioRunSnapshotFile>,
  durable = false
): Promise<void> {
  for (const segment of prefix) {
    assertSafeSegment(segment);
  }
  accountDirectory(budget, durable);
  const directory = path.join(root, ...prefix);
  const metadata = await lstat(directory).catch((cause: unknown) => {
    if (durable && isDeterministicFilesystemFailure(cause)) {
      throw snapshotIntegrityFailure(
        "Durable native run snapshot directory is missing or invalid",
        cause
      );
    }
    throw snapshotFailure("Native run snapshot directory is unavailable", cause);
  });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw snapshotContentFailure(
      durable,
      "Native run snapshot roots must contain physical directories"
    );
  }

  const handle = await opendir(directory).catch((cause: unknown) => {
    if (durable && isDeterministicFilesystemFailure(cause)) {
      throw snapshotIntegrityFailure(
        "Durable native run snapshot directory is missing or invalid",
        cause
      );
    }
    throw snapshotFailure("Native run snapshot directory is unavailable", cause);
  });
  try {
    const entries = [];
    for await (const entry of handle) {
      entries.push(entry);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      assertSafeSegment(entry.name);
      const segments = [...prefix, entry.name];
      if (entry.isSymbolicLink()) {
        throw snapshotContentFailure(
          durable,
          "Symbolic links are not allowed in native run snapshots"
        );
      }
      if (entry.isDirectory()) {
        await captureTree(root, rootKind, segments, budget, files, durable);
        continue;
      }
      if (!entry.isFile()) {
        throw snapshotContentFailure(
          durable,
          "Only regular files are allowed in native run snapshots"
        );
      }
      const file = await captureFile(
        root,
        rootKind,
        segments,
        budget,
        durable
      );
      files.set(`${file.root}/${file.path}`, file);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function workflowSource(
  files: ReadonlyMap<string, NativeStudioRunSnapshotFile>,
  workflowId: string
): string {
  const file = files.get(`project/workflows/${workflowId}/workflow.yaml`);
  if (file === undefined) {
    throw snapshotFailure("Native run snapshot is missing workflow.yaml");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(file.content);
  } catch (cause) {
    throw snapshotFailure("Workflow definition must be valid UTF-8", cause);
  }
}

function manifestMaterial(
  files: readonly NativeStudioRunSnapshotFile[]
): readonly NativeStudioRunSnapshotFileManifest[] {
  return files.map(({ content: _content, ...manifest }) => manifest);
}

function snapshotFromFiles(
  workflowId: string,
  files: readonly NativeStudioRunSnapshotFile[],
  totalBytes: number
): NativeStudioRunSnapshot {
  const ordered = [...files].sort((left, right) =>
    `${left.root}/${left.path}`.localeCompare(`${right.root}/${right.path}`)
  );
  const manifestFiles = manifestMaterial(ordered);
  const bundleHash = studioRunValueDigest({
    schema_version: 1,
    workflow_id: workflowId,
    files: manifestFiles
  });
  NativeStudioRunSnapshotManifestSchema.parse({
    schema_version: 1,
    workflow_id: workflowId,
    bundle_hash: bundleHash,
    total_bytes: totalBytes,
    files: manifestFiles
  });
  return {
    schema_version: 1,
    workflow_id: workflowId,
    bundle_hash: bundleHash,
    total_bytes: totalBytes,
    files: ordered
  };
}

export async function captureNativeStudioRunSnapshot(options: {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly workflowId: string;
}): Promise<NativeStudioRunSnapshot> {
  assertSafeSegment(options.workflowId);
  const budget: CaptureBudget = { files: 0, directories: 0, bytes: 0 };
  const files = new Map<string, NativeStudioRunSnapshotFile>();
  await Promise.all([
    captureTree(
      path.resolve(options.projectRoot),
      "project",
      ["workflows", options.workflowId],
      budget,
      files
    ),
    captureTree(
      path.resolve(options.configRoot),
      "config",
      [],
      budget,
      files
    )
  ]);

  const references = readWorkflowDefinitionReferences(
    workflowSource(files, options.workflowId)
  );
  const agentIds = [...new Set(references.agents.map(({ agentId }) => agentId))]
    .sort((left, right) => left.localeCompare(right));
  for (const agentId of agentIds) {
    assertSafeSegment(agentId);
    await captureTree(
      path.resolve(options.projectRoot),
      "project",
      ["agents", agentId],
      budget,
      files
    );
  }

  return snapshotFromFiles(options.workflowId, [...files.values()], budget.bytes);
}

export function nativeStudioRunSnapshotManifest(
  snapshot: NativeStudioRunSnapshot
): NativeStudioRunSnapshotManifest {
  const manifest = NativeStudioRunSnapshotManifestSchema.parse({
    ...snapshot,
    files: manifestMaterial(snapshot.files)
  });
  const expectedBundleHash = studioRunValueDigest({
    schema_version: manifest.schema_version,
    workflow_id: manifest.workflow_id,
    files: manifest.files
  });
  if (expectedBundleHash !== manifest.bundle_hash) {
    throw snapshotFailure("Native run snapshot bundle hash is invalid");
  }
  return manifest;
}

export async function readMaterializedNativeStudioRunSnapshot(options: {
  readonly roots: { readonly projectRoot: string; readonly configRoot: string };
  readonly workflowId: string;
}): Promise<NativeStudioRunSnapshot> {
  const budget: CaptureBudget = { files: 0, directories: 0, bytes: 0 };
  const files = new Map<string, NativeStudioRunSnapshotFile>();
  await Promise.all([
    captureTree(
      path.resolve(options.roots.projectRoot),
      "project",
      [],
      budget,
      files,
      true
    ),
    captureTree(
      path.resolve(options.roots.configRoot),
      "config",
      [],
      budget,
      files,
      true
    )
  ]);
  return snapshotFromFiles(options.workflowId, [...files.values()], budget.bytes);
}

export async function verifyMaterializedNativeStudioRunSnapshot(options: {
  readonly roots: { readonly projectRoot: string; readonly configRoot: string };
  readonly manifest: NativeStudioRunSnapshotManifest;
}): Promise<void> {
  const expected = NativeStudioRunSnapshotManifestSchema.parse(options.manifest);
  const actual = nativeStudioRunSnapshotManifest(
    await readMaterializedNativeStudioRunSnapshot({
      roots: options.roots,
      workflowId: expected.workflow_id
    })
  );
  if (studioRunValueDigest(actual) !== studioRunValueDigest(expected)) {
    throw snapshotIntegrityFailure(
      "Durable native run snapshot does not match its manifest"
    );
  }
}

async function writeSnapshotFile(
  root: string,
  file: NativeStudioRunSnapshotFile
): Promise<void> {
  const segments = file.path.split("/");
  const destination = path.join(root, ...segments);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const handle = await open(
    destination,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(file.content);
    await handle.chmod(file.mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function materializeNativeStudioRunSnapshot(
  snapshot: NativeStudioRunSnapshot,
  roots: { readonly projectRoot: string; readonly configRoot: string }
): Promise<void> {
  nativeStudioRunSnapshotManifest(snapshot);
  await Promise.all([
    mkdir(roots.projectRoot, { recursive: true, mode: 0o700 }),
    mkdir(roots.configRoot, { recursive: true, mode: 0o700 })
  ]);
  for (const file of snapshot.files) {
    if (
      file.content.byteLength !== file.bytes ||
      digest(file.content) !== file.sha256
    ) {
      throw snapshotFailure("Native run snapshot content does not match its manifest");
    }
    await writeSnapshotFile(
      file.root === "project" ? roots.projectRoot : roots.configRoot,
      file
    );
  }
}

export async function withMaterializedNativeStudioRunSnapshot<T>(
  snapshot: NativeStudioRunSnapshot,
  use: (roots: {
    readonly projectRoot: string;
    readonly configRoot: string;
  }) => Promise<T>
): Promise<T> {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), `luna-studio-run-${randomBytes(6).toString("hex")}-`)
  );
  const roots = {
    projectRoot: path.join(temporaryRoot, "project"),
    configRoot: path.join(temporaryRoot, "config")
  };
  try {
    await materializeNativeStudioRunSnapshot(snapshot, roots);
    return await use(roots);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
