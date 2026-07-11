import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath
} from "node:fs/promises";
import path from "node:path";
import type {
  StudioApplySourceFile,
  StudioApplySourcePort
} from "../../application/apply/ports.js";
import { StudioApplyError } from "../../application/apply/errors.js";
import { StudioPathSchema, type StudioPath, type StudioRoot } from "../../contracts/paths.js";

type EntryIdentity = {
  readonly dev: number;
  readonly ino: number;
};

type PinnedRoot = {
  readonly configuredPath: string;
  readonly physicalPath: string;
  readonly identity: EntryIdentity;
};

export type ResolvedStudioApplyTarget = {
  readonly file: StudioPath;
  readonly targetPath: string;
  readonly parentPath: string;
  readonly parentIdentity: EntryIdentity;
  readonly createdDirectories: readonly {
    readonly logicalPath: string;
    readonly physicalPath: string;
  }[];
};

export type StudioApplyPathRoots = {
  readonly project: string;
  readonly config: string;
};

function isErrno(cause: unknown, code: string): boolean {
  return (cause as NodeJS.ErrnoException).code === code;
}

function identity(metadata: { readonly dev: number; readonly ino: number }): EntryIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function sameIdentity(
  left: EntryIdentity,
  right: EntryIdentity
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function pathFailure(
  file: StudioPath,
  message: string,
  cause?: unknown
): StudioApplyError {
  return new StudioApplyError("studio_apply_path_invalid", message, {
    cause,
    details: { file }
  });
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

export class StudioApplyPathResolver {
  private readonly configured: StudioApplyPathRoots;
  private pinned: Promise<Record<StudioRoot, PinnedRoot>> | undefined;

  constructor(roots: StudioApplyPathRoots) {
    this.configured = {
      project: path.resolve(roots.project),
      config: path.resolve(roots.config)
    };
  }

  async resolveForMutation(
    rawFile: StudioPath
  ): Promise<ResolvedStudioApplyTarget> {
    const file = StudioPathSchema.parse(rawFile);
    const root = await this.root(file.root);
    const segments = file.path.split("/");
    const basename = segments.pop();
    if (basename === undefined) {
      throw pathFailure(file, "Studio apply path has no basename");
    }
    let current = root.physicalPath;
    const createdDirectories: {
      logicalPath: string;
      physicalPath: string;
    }[] = [];
    const logical: string[] = [];

    for (const segment of segments) {
      logical.push(segment);
      const candidate = path.join(current, segment);
      let metadata;
      try {
        metadata = await lstat(candidate);
      } catch (cause) {
        if (!isErrno(cause, "ENOENT")) {
          throw pathFailure(file, "Unable to inspect an apply path ancestor", cause);
        }
        try {
          await mkdir(candidate, { mode: 0o700 });
          await syncDirectory(current);
          metadata = await lstat(candidate);
          createdDirectories.push({
            logicalPath: logical.join("/"),
            physicalPath: candidate
          });
        } catch (createCause) {
          if (!isErrno(createCause, "EEXIST")) {
            throw pathFailure(
              file,
              "Unable to create an authorized apply path ancestor",
              createCause
            );
          }
          metadata = await lstat(candidate);
        }
      }
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw pathFailure(
          file,
          "Studio apply path ancestors must be real directories"
        );
      }
      const physical = await realpath(candidate);
      if (!isInside(root.physicalPath, physical)) {
        throw pathFailure(file, "Studio apply path escapes its authorized root");
      }
      current = physical;
    }
    const parentMetadata = await lstat(current);
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
      throw pathFailure(file, "Studio apply parent must be a real directory");
    }
    return {
      file,
      targetPath: path.join(current, basename),
      parentPath: current,
      parentIdentity: identity(parentMetadata),
      createdDirectories
    };
  }

  async revalidate(target: ResolvedStudioApplyTarget): Promise<void> {
    const root = await this.root(target.file.root);
    const parent = await lstat(target.parentPath);
    if (
      parent.isSymbolicLink() ||
      !parent.isDirectory() ||
      !sameIdentity(identity(parent), target.parentIdentity) ||
      !isInside(root.physicalPath, target.targetPath)
    ) {
      throw pathFailure(
        target.file,
        "Studio apply path identity changed during the transaction"
      );
    }
    const resolved = await this.resolveExistingParent(target.file);
    if (
      resolved === undefined ||
      resolved.targetPath !== target.targetPath ||
      !sameIdentity(resolved.parentIdentity, target.parentIdentity)
    ) {
      throw pathFailure(
        target.file,
        "Studio apply logical path changed during the transaction"
      );
    }
  }

  async physicalTargetPath(rawFile: StudioPath): Promise<string> {
    const file = StudioPathSchema.parse(rawFile);
    const root = await this.root(file.root);
    const target = path.join(root.physicalPath, ...file.path.split("/"));
    if (!isInside(root.physicalPath, target)) {
      throw pathFailure(file, "Studio apply path escapes its authorized root");
    }
    return target;
  }

  async resolveExistingParent(
    rawFile: StudioPath
  ): Promise<Omit<ResolvedStudioApplyTarget, "createdDirectories"> | undefined> {
    const file = StudioPathSchema.parse(rawFile);
    const root = await this.root(file.root);
    const segments = file.path.split("/");
    const basename = segments.pop();
    if (basename === undefined) {
      return undefined;
    }
    let current = root.physicalPath;
    for (const segment of segments) {
      const candidate = path.join(current, segment);
      let metadata;
      try {
        metadata = await lstat(candidate);
      } catch (cause) {
        if (isErrno(cause, "ENOENT")) {
          return undefined;
        }
        throw pathFailure(file, "Unable to inspect an apply path ancestor", cause);
      }
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw pathFailure(
          file,
          "Studio apply path ancestors must be real directories"
        );
      }
      current = await realpath(candidate);
      if (!isInside(root.physicalPath, current)) {
        throw pathFailure(file, "Studio apply path escapes its authorized root");
      }
    }
    const parentMetadata = await lstat(current);
    return {
      file,
      targetPath: path.join(current, basename),
      parentPath: current,
      parentIdentity: identity(parentMetadata)
    };
  }

  private async root(root: StudioRoot): Promise<PinnedRoot> {
    this.pinned ??= this.pinRoots();
    const pinned = (await this.pinned)[root];
    const configuredEntry = await lstat(pinned.configuredPath);
    const configuredReal = await realpath(pinned.configuredPath);
    if (
      configuredEntry.isSymbolicLink() ||
      !configuredEntry.isDirectory() ||
      configuredReal !== pinned.physicalPath ||
      !sameIdentity(identity(configuredEntry), pinned.identity)
    ) {
      throw new StudioApplyError(
        "studio_apply_path_invalid",
        `Studio ${root} root identity changed`
      );
    }
    return pinned;
  }

  private async pinRoots(): Promise<Record<StudioRoot, PinnedRoot>> {
    return {
      project: await this.pinRoot("project", this.configured.project),
      config: await this.pinRoot("config", this.configured.config)
    };
  }

  private async pinRoot(root: StudioRoot, configuredPath: string): Promise<PinnedRoot> {
    let entry;
    try {
      entry = await lstat(configuredPath);
    } catch (cause) {
      throw new StudioApplyError(
        "studio_apply_path_invalid",
        `Studio ${root} root is unavailable`,
        { cause }
      );
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new StudioApplyError(
        "studio_apply_path_invalid",
        `Studio ${root} root must be a real directory`
      );
    }
    const physicalPath = await realpath(configuredPath);
    if (physicalPath !== configuredPath) {
      throw new StudioApplyError(
        "studio_apply_path_invalid",
        `Studio ${root} root must already be physically resolved`
      );
    }
    return {
      configuredPath,
      physicalPath,
      identity: identity(entry)
    };
  }
}

export class FileSystemStudioApplySource implements StudioApplySourcePort {
  constructor(private readonly resolver: StudioApplyPathResolver) {}

  async read(
    file: StudioPath,
    options: { readonly maxBytes: number }
  ): Promise<StudioApplySourceFile | undefined> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new StudioApplyError(
        "studio_apply_config_invalid",
        "Studio apply source read limit must be a positive safe integer"
      );
    }
    const target = await this.resolver.resolveExistingParent(file);
    if (target === undefined) {
      return undefined;
    }
    await this.resolver.revalidate({ ...target, createdDirectories: [] });

    let handle;
    try {
      handle = await open(
        target.targetPath,
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) {
        return undefined;
      }
      throw pathFailure(file, "Unable to open an apply source file safely", cause);
    }
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) {
        throw pathFailure(file, "Studio apply source must be a regular file");
      }
      const named = await lstat(target.targetPath);
      if (
        named.isSymbolicLink() ||
        !named.isFile() ||
        !sameIdentity(identity(opened), identity(named))
      ) {
        throw pathFailure(file, "Studio apply source changed while it was opened");
      }
      if (opened.size > options.maxBytes) {
        throw new StudioApplyError(
          "studio_apply_source_too_large",
          "Studio apply source exceeds its file byte limit",
          {
            details: {
              file,
              actualBytes: opened.size,
              maxBytes: options.maxBytes
            }
          }
        );
      }
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const remaining = options.maxBytes + 1 - total;
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
        const read = await handle.read(chunk, 0, chunk.length, null);
        if (read.bytesRead === 0) {
          break;
        }
        total += read.bytesRead;
        if (total > options.maxBytes) {
          throw new StudioApplyError(
            "studio_apply_source_too_large",
            "Studio apply source grew beyond its file byte limit",
            {
              details: { file, actualBytes: total, maxBytes: options.maxBytes }
            }
          );
        }
        chunks.push(chunk.subarray(0, read.bytesRead));
      }
      await this.resolver.revalidate({ ...target, createdDirectories: [] });
      const namedAfter = await lstat(target.targetPath);
      if (
        namedAfter.isSymbolicLink() ||
        !namedAfter.isFile() ||
        !sameIdentity(identity(opened), identity(namedAfter))
      ) {
        throw pathFailure(file, "Studio apply source changed while it was read");
      }
      const content = Buffer.concat(chunks, total);
      return {
        content,
        sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        mode: opened.mode & 0o777
      };
    } finally {
      await handle.close();
    }
  }
}

export async function syncStudioApplyDirectory(directory: string): Promise<void> {
  await syncDirectory(directory);
}
