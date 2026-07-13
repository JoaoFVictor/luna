import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  link,
  open,
  opendir,
  rename,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../../../core/workflow/definition-digests.js";
import {
  studioRunDigestsEqual,
  studioRunValueDigest
} from "../../application/runs/launch-digests.js";
import { StudioRunLaunchError } from "../../application/runs/launch-errors.js";
import { RunOpaqueIdSchema } from "../../contracts/runs.js";
import {
  NativeStudioQueuedResumeMaterialSchema,
  NativeStudioQueuedResumeSchema,
  nativeStudioQueuedResumeMaterial,
  type NativeStudioQueuedResume,
  type NativeStudioQueuedResumeMaterial
} from "./run-resume-contracts.js";
import {
  MAX_JOB_FILE_BYTES,
  ensurePrivateDirectory,
  isErrno,
  queueCorruptionError,
  queueError,
  syncDirectory,
  writeDurableFile
} from "./run-queue-filesystem.js";

export class NativeStudioRunResumeQueue {
  readonly #resumesRoot: string;
  readonly #quarantineRoot: string;

  constructor(root: string) {
    this.#resumesRoot = path.join(root, "resumes");
    this.#quarantineRoot = path.join(root, "resume-quarantine");
  }

  async initializeDirectories(): Promise<void> {
    await ensurePrivateDirectory(this.#resumesRoot);
    await ensurePrivateDirectory(this.#quarantineRoot);
  }

  async removeAbandonedStagingFiles(): Promise<void> {
    const handle = await opendir(this.#resumesRoot);
    try {
      for await (const entry of handle) {
        if (!entry.name.startsWith(".creating-")) continue;
        const candidate = path.join(this.#resumesRoot, entry.name);
        if (entry.isFile() && !entry.isSymbolicLink()) {
          await unlink(candidate).catch((cause) => {
            if (!isErrno(cause, "ENOENT")) throw cause;
          });
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    await syncDirectory(this.#resumesRoot);
  }

  async accept(
    material: NativeStudioQueuedResumeMaterial
  ): Promise<{ readonly job: NativeStudioQueuedResume; readonly created: boolean }> {
    const parsed = NativeStudioQueuedResumeMaterialSchema.parse(material);
    const job = NativeStudioQueuedResumeSchema.parse({
      ...parsed,
      command_hash: studioRunValueDigest(parsed)
    });
    const staging = path.join(
      this.#resumesRoot,
      `.creating-${job.resume_id}-${randomBytes(8).toString("hex")}`
    );
    let created = false;
    try {
      await writeDurableFile(staging, canonicalJson(job));
      await link(staging, this.resumeFile(job.resume_id));
      created = true;
      await syncDirectory(this.#resumesRoot);
    } catch (cause) {
      if (!isErrno(cause, "EEXIST")) {
        throw queueError("Native run resume could not be durably queued", cause);
      }
    } finally {
      await unlink(staging).catch((cause) => {
        if (!isErrno(cause, "ENOENT")) throw cause;
      });
      await syncDirectory(this.#resumesRoot);
    }
    if (created) return { job, created: true };
    const existing = await this.read(job.resume_id);
    if (
      existing.run_id !== job.run_id ||
      existing.interrupt_id !== job.interrupt_id ||
      !studioRunDigestsEqual(existing.command_hash, job.command_hash)
    ) {
      throw queueError("Interrupt was already queued with a different resume decision");
    }
    return { job: existing, created: false };
  }

  async read(resumeId: string): Promise<NativeStudioQueuedResume> {
    const id = RunOpaqueIdSchema.parse(resumeId);
    let handle;
    try {
      handle = await open(
        this.resumeFile(id),
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
    } catch (cause) {
      throw queueError("Native run resume job is unavailable", cause);
    }
    try {
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile() || metadata.size > MAX_JOB_FILE_BYTES) {
        throw queueCorruptionError("Native run resume job exceeds its read limit");
      }
      const content = await handle.readFile();
      const final = await handle.stat({ bigint: true });
      if (
        !final.isFile() ||
        final.dev !== metadata.dev ||
        final.ino !== metadata.ino ||
        final.size !== metadata.size ||
        final.mtimeNs !== metadata.mtimeNs ||
        BigInt(content.byteLength) !== metadata.size
      ) {
        throw queueCorruptionError("Native run resume job changed while reading");
      }
      let raw: unknown;
      try {
        raw = JSON.parse(content.toString("utf8"));
      } catch (cause) {
        throw queueCorruptionError("Native run resume job is not valid JSON", cause);
      }
      const job = NativeStudioQueuedResumeSchema.parse(raw);
      if (
        job.resume_id !== id ||
        !studioRunDigestsEqual(
          job.command_hash,
          studioRunValueDigest(nativeStudioQueuedResumeMaterial(job))
        )
      ) {
        throw queueCorruptionError("Native run resume job failed integrity validation");
      }
      return job;
    } catch (cause) {
      if (cause instanceof StudioRunLaunchError) throw cause;
      throw queueCorruptionError("Native run resume job is invalid", cause);
    } finally {
      await handle.close();
    }
  }

  async listIds(): Promise<readonly string[]> {
    const handle = await opendir(this.#resumesRoot);
    const ids: string[] = [];
    try {
      for await (const entry of handle) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const parsed = RunOpaqueIdSchema.safeParse(entry.name.slice(0, -5));
        if (parsed.success) ids.push(parsed.data);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    return ids.sort((left, right) => left.localeCompare(right));
  }

  async remove(resumeId: string): Promise<void> {
    const id = RunOpaqueIdSchema.parse(resumeId);
    try {
      await unlink(this.resumeFile(id));
      await syncDirectory(this.#resumesRoot);
    } catch (cause) {
      if (!isErrno(cause, "ENOENT")) {
        throw queueError("Native run resume job could not be removed", cause);
      }
    }
  }

  async quarantine(resumeId: string): Promise<boolean> {
    const id = RunOpaqueIdSchema.parse(resumeId);
    const source = this.resumeFile(id);
    const quarantine = path.join(
      this.#quarantineRoot,
      `${id}-${randomBytes(8).toString("hex")}.json`
    );
    try {
      const metadata = await lstat(source);
      if (metadata.isDirectory()) {
        throw queueError("Native run resume quarantine source is invalid");
      }
      await rename(source, quarantine);
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) return false;
      if (cause instanceof StudioRunLaunchError) throw cause;
      throw queueError("Native run resume job could not be quarantined", cause);
    }
    try {
      await syncDirectory(this.#resumesRoot);
      await syncDirectory(this.#quarantineRoot);
    } catch (cause) {
      throw queueError(
        "Native run resume quarantine could not be persisted",
        cause
      );
    }
    return true;
  }

  private resumeFile(resumeId: string): string {
    return path.join(this.#resumesRoot, `${resumeId}.json`);
  }
}
