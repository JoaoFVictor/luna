import { constants } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { studioApplyBytesDigest } from "../../application/apply/digests.js";
import { StudioApplyError } from "../../application/apply/errors.js";
import type {
  StudioApplySourcePort,
  StudioApplyTransactionEntry
} from "../../application/apply/ports.js";
import { studioPathKey, type StudioPath } from "../../contracts/paths.js";
import type { StudioApplyJournal } from "./apply-journal.js";
import {
  StudioApplyPathResolver,
  syncStudioApplyDirectory,
  type ResolvedStudioApplyTarget
} from "./apply-paths.js";

export type StudioApplyWorkspaceFault = (
  stage: "after_backup_entry" | "after_install_entry",
  context: { readonly operationId: string; readonly entryIndex: number }
) => Promise<void> | void;

type PhysicalFile = {
  readonly sha256: string;
  readonly mode: number;
};

type ResolvedEntry = {
  readonly target: ResolvedStudioApplyTarget;
  readonly workDirectory: string;
  readonly stagePath: string;
  readonly backupPath: string;
};

function isErrno(cause: unknown, code: string): boolean {
  return (cause as NodeJS.ErrnoException).code === code;
}

function workspaceError(
  journal: StudioApplyJournal,
  message: string,
  file?: StudioPath,
  cause?: unknown
): StudioApplyError {
  return new StudioApplyError("studio_apply_recovery_required", message, {
    cause,
    details: {
      operationId: journal.operation_id,
      ...(file === undefined ? {} : { file })
    }
  });
}

async function readPhysicalFile(
  filePath: string,
  maxBytes: number
): Promise<PhysicalFile | undefined> {
  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) {
      return undefined;
    }
    throw cause;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) {
      throw new StudioApplyError(
        "studio_apply_source_invalid",
        "Studio apply workspace entry is invalid or oversized"
      );
    }
    const content = await handle.readFile();
    if (content.byteLength > maxBytes) {
      throw new StudioApplyError(
        "studio_apply_source_too_large",
        "Studio apply workspace entry exceeds its byte limit"
      );
    }
    return {
      sha256: studioApplyBytesDigest(content),
      mode: metadata.mode & 0o777
    };
  } finally {
    await handle.close();
  }
}

async function removeKnownFile(
  filePath: string,
  expectedSha256: string,
  maxBytes: number
): Promise<void> {
  const current = await readPhysicalFile(filePath, maxBytes);
  if (current === undefined) {
    return;
  }
  if (current.sha256 !== expectedSha256) {
    throw new StudioApplyError(
      "studio_apply_recovery_required",
      "Refusing to remove an apply workspace file with unexpected content"
    );
  }
  await unlink(filePath);
  await syncStudioApplyDirectory(path.dirname(filePath));
}

async function assertWorkDirectory(
  directory: string,
  required: boolean
): Promise<boolean> {
  let entry;
  try {
    entry = await lstat(directory);
  } catch (cause) {
    if (isErrno(cause, "ENOENT") && !required) {
      return false;
    }
    throw cause;
  }
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (await realpath(directory)) !== directory
  ) {
    throw new StudioApplyError(
      "studio_apply_recovery_required",
      "Studio apply workspace directory identity is invalid"
    );
  }
  return true;
}

export class StudioApplyWorkspace {
  private readonly resolver: StudioApplyPathResolver;
  private readonly source: StudioApplySourcePort;
  private readonly maxFileBytes: number;
  private readonly faultInjector: StudioApplyWorkspaceFault | undefined;

  constructor(options: {
    readonly resolver: StudioApplyPathResolver;
    readonly source: StudioApplySourcePort;
    readonly maxFileBytes: number;
    readonly faultInjector?: StudioApplyWorkspaceFault;
  }) {
    this.resolver = options.resolver;
    this.source = options.source;
    this.maxFileBytes = options.maxFileBytes;
    this.faultInjector = options.faultInjector;
  }

  async assertNoPhysicalAliases(files: readonly StudioPath[]): Promise<void> {
    const logical = new Set<string>();
    const physical = new Map<string, StudioPath>();
    for (const file of files) {
      const logicalKey = studioPathKey(file);
      if (logical.has(logicalKey)) {
        continue;
      }
      logical.add(logicalKey);
      const physicalPath = await this.resolver.physicalTargetPath(file);
      const previous = physical.get(physicalPath);
      if (previous !== undefined) {
        throw new StudioApplyError(
          "studio_apply_path_invalid",
          "Distinct Studio paths resolve to the same physical apply target",
          { details: { file } }
        );
      }
      physical.set(physicalPath, file);
    }
  }

  async prepare(
    journal: StudioApplyJournal,
    entries: readonly StudioApplyTransactionEntry[],
    onCreatedDirectories: (
      directories: readonly StudioPath[]
    ) => Promise<void>
  ): Promise<void> {
    await this.assertGuards(journal, "before");
    const entryByKey = new Map(entries.map((entry) => [studioPathKey(entry.file), entry]));
    const ownedWorkDirectories = new Set<string>();
    const created = new Map<string, StudioPath>();

    for (const persisted of journal.entries) {
      const input = entryByKey.get(studioPathKey(persisted.file));
      if (input === undefined) {
        throw workspaceError(journal, "Apply journal entry has no transaction content", persisted.file);
      }
      const resolved = await this.resolver.resolveForMutation(persisted.file);
      for (const directory of resolved.createdDirectories) {
        const logical: StudioPath = {
          root: persisted.file.root,
          path: directory.logicalPath
        };
        created.set(studioPathKey(logical), logical);
      }
      if (resolved.createdDirectories.length > 0) {
        await onCreatedDirectories([...created.values()]);
      }
      await this.resolver.revalidate(resolved);
      const workspace = this.resolvedEntry(journal, persisted.index, resolved);
      if (!ownedWorkDirectories.has(workspace.workDirectory)) {
        try {
          await mkdir(workspace.workDirectory, { mode: 0o700 });
        } catch (cause) {
          if (!isErrno(cause, "EEXIST")) {
            throw workspaceError(
              journal,
              "Unable to create apply workspace on the target filesystem",
              persisted.file,
              cause
            );
          }
          throw workspaceError(
            journal,
            "Apply workspace already exists for a new transaction",
            persisted.file
          );
        }
        ownedWorkDirectories.add(workspace.workDirectory);
        await syncStudioApplyDirectory(resolved.parentPath);
      }
      await assertWorkDirectory(workspace.workDirectory, true);

      const actual = await this.source.read(persisted.file, {
        maxBytes: this.maxFileBytes
      });
      if ((actual?.sha256 ?? null) !== persisted.before_sha256) {
        throw workspaceError(
          journal,
          "Apply source changed while staging the transaction",
          persisted.file
        );
      }
      if (
        persisted.before_sha256 !== null &&
        actual?.mode !== persisted.before_mode
      ) {
        throw workspaceError(
          journal,
          "Apply source mode changed while staging the transaction",
          persisted.file
        );
      }
      if (persisted.action === "write") {
        if (
          input.content === undefined ||
          persisted.after_sha256 === null ||
          persisted.mode === null ||
          studioApplyBytesDigest(input.content) !== persisted.after_sha256
        ) {
          throw workspaceError(
            journal,
            "Apply write content does not match its journal",
            persisted.file
          );
        }
        const stage = await open(
          workspace.stagePath,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          persisted.mode
        );
        try {
          await stage.writeFile(input.content);
          await stage.chmod(persisted.mode);
          await stage.sync();
        } finally {
          await stage.close();
        }
        await syncStudioApplyDirectory(workspace.workDirectory);
        const staged = await readPhysicalFile(
          workspace.stagePath,
          this.maxFileBytes
        );
        if (
          staged?.sha256 !== persisted.after_sha256 ||
          staged.mode !== persisted.mode
        ) {
          throw workspaceError(
            journal,
            "Staged apply file failed hash or mode verification",
            persisted.file
          );
        }
      }
    }
  }

  async backUp(journal: StudioApplyJournal): Promise<void> {
    await this.assertGuards(journal, "before");
    for (const entry of journal.entries) {
      const resolved = await this.requireResolvedEntry(journal, entry.file, entry.index);
      await this.resolver.revalidate(resolved.target);
      await assertWorkDirectory(resolved.workDirectory, true);
      const target = await this.source.read(entry.file, {
        maxBytes: this.maxFileBytes
      });
      if ((target?.sha256 ?? null) !== entry.before_sha256) {
        throw workspaceError(
          journal,
          "Apply source changed immediately before backup",
          entry.file
        );
      }
      if (
        entry.before_sha256 !== null &&
        target?.mode !== entry.before_mode
      ) {
        throw workspaceError(
          journal,
          "Apply source mode changed immediately before backup",
          entry.file
        );
      }
      const existingBackup = await readPhysicalFile(
        resolved.backupPath,
        this.maxFileBytes
      );
      if (existingBackup !== undefined) {
        throw workspaceError(journal, "Unexpected apply backup already exists", entry.file);
      }
      if (entry.before_sha256 !== null) {
        await this.resolver.revalidate(resolved.target);
        await assertWorkDirectory(resolved.workDirectory, true);
        await rename(resolved.target.targetPath, resolved.backupPath);
        await syncStudioApplyDirectory(resolved.target.parentPath);
        await syncStudioApplyDirectory(resolved.workDirectory);
        const backup = await readPhysicalFile(
          resolved.backupPath,
          this.maxFileBytes
        );
        if (
          backup?.sha256 !== entry.before_sha256 ||
          backup.mode !== entry.before_mode
        ) {
          throw workspaceError(journal, "Apply backup hash is invalid", entry.file);
        }
      }
      await this.faultInjector?.("after_backup_entry", {
        operationId: journal.operation_id,
        entryIndex: entry.index
      });
    }
  }

  async install(journal: StudioApplyJournal): Promise<void> {
    for (const entry of journal.entries) {
      const resolved = await this.requireResolvedEntry(journal, entry.file, entry.index);
      await this.resolver.revalidate(resolved.target);
      await assertWorkDirectory(resolved.workDirectory, true);
      const current = await this.source.read(entry.file, {
        maxBytes: this.maxFileBytes
      });
      if (current !== undefined) {
        throw workspaceError(
          journal,
          "Apply target unexpectedly exists after backup",
          entry.file
        );
      }
      if (entry.action === "write") {
        const stage = await readPhysicalFile(
          resolved.stagePath,
          this.maxFileBytes
        );
        if (
          stage?.sha256 !== entry.after_sha256 ||
          stage.mode !== entry.mode
        ) {
          throw workspaceError(journal, "Apply stage is missing or corrupt", entry.file);
        }
        await this.resolver.revalidate(resolved.target);
        await assertWorkDirectory(resolved.workDirectory, true);
        await link(resolved.stagePath, resolved.target.targetPath);
        await syncStudioApplyDirectory(resolved.target.parentPath);
        await unlink(resolved.stagePath);
        await syncStudioApplyDirectory(resolved.workDirectory);
      }
      const installed = await this.source.read(entry.file, {
        maxBytes: this.maxFileBytes
      });
      if (
        (installed?.sha256 ?? null) !== entry.after_sha256 ||
        (entry.action === "write" && installed?.mode !== entry.mode)
      ) {
        throw workspaceError(journal, "Installed apply target failed verification", entry.file);
      }
      await this.faultInjector?.("after_install_entry", {
        operationId: journal.operation_id,
        entryIndex: entry.index
      });
    }
  }

  async isFullyInstalled(journal: StudioApplyJournal): Promise<boolean> {
    try {
      await this.assertGuards(journal, "after");
      for (const entry of journal.entries) {
        const actual = await this.source.read(entry.file, {
          maxBytes: this.maxFileBytes
        });
        if (
          (actual?.sha256 ?? null) !== entry.after_sha256 ||
          (entry.action === "write" && actual?.mode !== entry.mode)
        ) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  async verifyInstalled(journal: StudioApplyJournal): Promise<void> {
    if (!(await this.isFullyInstalled(journal))) {
      throw workspaceError(journal, "Installed apply transaction does not match its journal");
    }
  }

  async rollBack(journal: StudioApplyJournal): Promise<void> {
    for (const entry of [...journal.entries].reverse()) {
      const resolvedParent = await this.resolver.resolveExistingParent(entry.file);
      if (resolvedParent === undefined) {
        if (entry.before_sha256 === null) {
          continue;
        }
        throw workspaceError(
          journal,
          "Apply rollback cannot resolve an original target parent",
          entry.file
        );
      }
      const resolved = this.resolvedEntry(
        journal,
        entry.index,
        { ...resolvedParent, createdDirectories: [] }
      );
      await this.resolver.revalidate(resolved.target);
      await assertWorkDirectory(resolved.workDirectory, false);
      const target = await this.source.read(entry.file, {
        maxBytes: this.maxFileBytes
      });
      const backup = await readPhysicalFile(
        resolved.backupPath,
        this.maxFileBytes
      );

      if (entry.before_sha256 === null) {
        if (backup !== undefined) {
          throw workspaceError(
            journal,
            "A newly created apply target has an unexpected backup",
            entry.file
          );
        }
        if (target !== undefined) {
          if (
            target.sha256 !== entry.after_sha256 ||
            target.mode !== entry.mode
          ) {
            throw workspaceError(
              journal,
              "Refusing to overwrite an externally modified apply target during rollback",
              entry.file
            );
          }
          await this.resolver.revalidate(resolved.target);
          await unlink(resolved.target.targetPath);
          await syncStudioApplyDirectory(resolved.target.parentPath);
        }
      } else if (backup !== undefined) {
        if (
          backup.sha256 !== entry.before_sha256 ||
          backup.mode !== entry.before_mode
        ) {
          throw workspaceError(journal, "Apply backup changed before rollback", entry.file);
        }
        if (target !== undefined) {
          if (
            target.sha256 === entry.before_sha256 &&
            target.mode === entry.before_mode
          ) {
            await removeKnownFile(
              resolved.backupPath,
              entry.before_sha256,
              this.maxFileBytes
            );
            continue;
          }
          if (
            target.sha256 !== entry.after_sha256 ||
            (entry.action === "write" && target.mode !== entry.mode)
          ) {
            throw workspaceError(
              journal,
              "Refusing to overwrite an externally modified apply target during rollback",
              entry.file
            );
          }
          await this.resolver.revalidate(resolved.target);
          await unlink(resolved.target.targetPath);
          await syncStudioApplyDirectory(resolved.target.parentPath);
        }
        await this.resolver.revalidate(resolved.target);
        await assertWorkDirectory(resolved.workDirectory, true);
        await rename(resolved.backupPath, resolved.target.targetPath);
        await syncStudioApplyDirectory(resolved.workDirectory);
        await syncStudioApplyDirectory(resolved.target.parentPath);
      } else if (
        target?.sha256 !== entry.before_sha256 ||
        target.mode !== entry.before_mode
      ) {
        throw workspaceError(
          journal,
          "Original apply target and its backup are both unavailable",
          entry.file
        );
      }

      const restored = await this.source.read(entry.file, {
        maxBytes: this.maxFileBytes
      });
      if (
        (restored?.sha256 ?? null) !== entry.before_sha256 ||
        (entry.before_sha256 !== null && restored?.mode !== entry.before_mode)
      ) {
        throw workspaceError(journal, "Apply rollback hash verification failed", entry.file);
      }
    }
  }

  async cleanUp(journal: StudioApplyJournal): Promise<void> {
    const visitedWorkDirectories = new Set<string>();
    for (const entry of journal.entries) {
      const parent = await this.resolver.resolveExistingParent(entry.file);
      if (parent === undefined) {
        continue;
      }
      const resolved = this.resolvedEntry(
        journal,
        entry.index,
        { ...parent, createdDirectories: [] }
      );
      await assertWorkDirectory(resolved.workDirectory, false);
      if (entry.after_sha256 !== null) {
        await removeKnownFile(
          resolved.stagePath,
          entry.after_sha256,
          this.maxFileBytes
        );
      }
      if (entry.before_sha256 !== null) {
        await removeKnownFile(
          resolved.backupPath,
          entry.before_sha256,
          this.maxFileBytes
        );
      }
      visitedWorkDirectories.add(resolved.workDirectory);
    }
    for (const directory of visitedWorkDirectories) {
      try {
        await rmdir(directory);
        await syncStudioApplyDirectory(path.dirname(directory));
      } catch (cause) {
        if (!isErrno(cause, "ENOENT") && !isErrno(cause, "ENOTEMPTY")) {
          throw cause;
        }
        // Unknown entries are preserved instead of recursively deleted.
      }
    }

    for (const directory of [...journal.created_directories].reverse()) {
      const sentinel: StudioPath = {
        root: directory.root,
        path: `${directory.path}/.luna-studio-cleanup-sentinel`
      };
      const resolved = await this.resolver.resolveExistingParent(sentinel);
      const directoryPath = resolved?.parentPath;
      if (directoryPath === undefined) {
        continue;
      }
      try {
        await rmdir(directoryPath);
        await syncStudioApplyDirectory(path.dirname(directoryPath));
      } catch (cause) {
        if (!isErrno(cause, "ENOENT") && !isErrno(cause, "ENOTEMPTY")) {
          throw cause;
        }
      }
    }
  }

  private async assertGuards(
    journal: StudioApplyJournal,
    phase: "before" | "after"
  ): Promise<void> {
    const changes = new Map(
      journal.entries.map((entry) => [studioPathKey(entry.file), entry])
    );
    for (const guard of journal.guards) {
      const change = changes.get(studioPathKey(guard.file));
      const expected =
        phase === "after" && change !== undefined
          ? change.after_sha256
          : guard.sha256;
      const expectedMode =
        phase === "after" && change !== undefined
          ? change.action === "write"
            ? (change.mode ?? null)
            : null
          : guard.mode;
      const current = await this.source.read(guard.file, {
        maxBytes: this.maxFileBytes
      });
      if (
        (current?.sha256 ?? null) !== expected ||
        (expectedMode !== undefined && (current?.mode ?? null) !== expectedMode)
      ) {
        throw workspaceError(
          journal,
          `Apply read-set changed ${phase} installation`,
          guard.file
        );
      }
    }
  }

  private async requireResolvedEntry(
    journal: StudioApplyJournal,
    file: StudioPath,
    index: number
  ): Promise<ResolvedEntry> {
    const target = await this.resolver.resolveExistingParent(file);
    if (target === undefined) {
      throw workspaceError(journal, "Apply target parent disappeared", file);
    }
    return this.resolvedEntry(journal, index, {
      ...target,
      createdDirectories: []
    });
  }

  private resolvedEntry(
    journal: StudioApplyJournal,
    index: number,
    target: ResolvedStudioApplyTarget
  ): ResolvedEntry {
    const workDirectory = path.join(
      target.parentPath,
      `.luna-studio-apply-${journal.operation_id}`
    );
    return {
      target,
      workDirectory,
      stagePath: path.join(workDirectory, `${index}.stage`),
      backupPath: path.join(workDirectory, `${index}.backup`)
    };
  }
}
