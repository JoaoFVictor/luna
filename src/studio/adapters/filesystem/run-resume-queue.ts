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
  isNativeStudioRunDispatchQueueCorruption,
  queueCorruptionError,
  queueError,
  syncDirectory,
  writeDurableFile
} from "./run-queue-filesystem.js";
import {
  NativeStudioRunResumeStageSchema,
  nativeStudioRunResumeStage,
  type NativeStudioRunResumeStage
} from "./run-resume-stage-contracts.js";
import {
  NativeStudioRunResumeIdentitySchema,
  nativeStudioRunResumeIdentity,
  type NativeStudioRunResumeIdentity
} from "./run-resume-identity-contracts.js";

export class NativeStudioRunResumeQueue {
  readonly #resumesRoot: string;
  readonly #quarantineRoot: string;
  readonly #stagesRoot: string;
  readonly #identitiesRoot: string;

  constructor(root: string) {
    this.#resumesRoot = path.join(root, "resumes");
    this.#quarantineRoot = path.join(root, "resume-quarantine");
    this.#stagesRoot = path.join(root, "resume-stages");
    this.#identitiesRoot = path.join(root, "resume-identities");
  }

  async initializeDirectories(): Promise<void> {
    await ensurePrivateDirectory(this.#resumesRoot);
    await ensurePrivateDirectory(this.#quarantineRoot);
    await ensurePrivateDirectory(this.#stagesRoot);
    await ensurePrivateDirectory(this.#identitiesRoot);
  }

  async removeAbandonedStagingFiles(): Promise<void> {
    await this.removeStagingFiles(this.#resumesRoot);
    await this.removeStagingFiles(this.#stagesRoot);
    await this.removeStagingFiles(this.#identitiesRoot);
    await this.removeOrphanStages();
  }

  private async removeStagingFiles(root: string): Promise<void> {
    const handle = await opendir(root);
    try {
      for await (const entry of handle) {
        if (!entry.name.startsWith(".creating-")) continue;
        const candidate = path.join(root, entry.name);
        if (entry.isFile() && !entry.isSymbolicLink()) {
          await unlink(candidate).catch((cause) => {
            if (!isErrno(cause, "ENOENT")) throw cause;
          });
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    await syncDirectory(root);
  }

  async accept(
    material: NativeStudioQueuedResumeMaterial
  ): Promise<{ readonly job: NativeStudioQueuedResume; readonly created: boolean }> {
    const supplied = NativeStudioQueuedResumeMaterialSchema.parse(material);
    const acceptedIdentity = await this.readIdentityIfPresent(supplied.resume_id);
    let parsed = NativeStudioQueuedResumeMaterialSchema.parse({
      ...supplied,
      ...(acceptedIdentity === undefined
        ? {}
        : { accepted_at: acceptedIdentity.accepted_at })
    });
    let job = NativeStudioQueuedResumeSchema.parse({
      ...parsed,
      command_hash: studioRunValueDigest(parsed)
    });
    const identity = await this.ensureIdentity(job);
    if (!studioRunDigestsEqual(identity.command_hash, job.command_hash)) {
      // A concurrent exact retry may have installed the first audit timestamp
      // after our initial read. Rebase once on that immutable timestamp and
      // require the complete command hash to match.
      parsed = NativeStudioQueuedResumeMaterialSchema.parse({
        ...supplied,
        accepted_at: identity.accepted_at
      });
      job = NativeStudioQueuedResumeSchema.parse({
        ...parsed,
        command_hash: studioRunValueDigest(parsed)
      });
    }
    if (
      identity.run_id !== job.run_id ||
      identity.interrupt_id !== job.interrupt_id ||
      !studioRunDigestsEqual(identity.command_hash, job.command_hash)
    ) {
      throw queueError("Interrupt was already queued with a different resume decision");
    }
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

  async inspectCommand(
    resumeId: string
  ): Promise<"valid" | "missing" | "corrupt"> {
    const id = RunOpaqueIdSchema.parse(resumeId);
    try {
      const metadata = await lstat(this.resumeFile(id));
      if (metadata.isSymbolicLink() || !metadata.isFile()) return "corrupt";
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) return "missing";
      throw cause;
    }
    try {
      await this.read(id);
      return "valid";
    } catch (cause) {
      if (isNativeStudioRunDispatchQueueCorruption(cause)) return "corrupt";
      try {
        await lstat(this.resumeFile(id));
      } catch (readbackCause) {
        if (isErrno(readbackCause, "ENOENT")) return "missing";
        throw readbackCause;
      }
      throw cause;
    }
  }

  async readIdentity(resumeId: string): Promise<NativeStudioRunResumeIdentity> {
    const id = RunOpaqueIdSchema.parse(resumeId);
    let handle;
    try {
      handle = await open(this.identityFile(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (cause) {
      throw queueError("Native run resume identity is unavailable", cause);
    }
    try {
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile() || metadata.size > MAX_JOB_FILE_BYTES) {
        throw queueCorruptionError("Native run resume identity exceeds its read limit");
      }
      const content = await handle.readFile();
      const final = await handle.stat({ bigint: true });
      if (
        !final.isFile() || final.dev !== metadata.dev || final.ino !== metadata.ino ||
        final.size !== metadata.size || final.mtimeNs !== metadata.mtimeNs ||
        BigInt(content.byteLength) !== metadata.size
      ) {
        throw queueCorruptionError("Native run resume identity changed while reading");
      }
      const parsed = NativeStudioRunResumeIdentitySchema.safeParse(
        JSON.parse(content.toString("utf8"))
      );
      if (!parsed.success || parsed.data.resume_id !== id) {
        throw queueCorruptionError("Native run resume identity failed integrity validation");
      }
      return parsed.data;
    } catch (cause) {
      if (isNativeStudioRunDispatchQueueCorruption(cause)) throw cause;
      throw queueCorruptionError("Native run resume identity is invalid", cause);
    } finally {
      await handle.close();
    }
  }

  async initializeStage(job: NativeStudioQueuedResume): Promise<void> {
    const stage = nativeStudioRunResumeStage({
      resumeId: job.resume_id,
      commandHash: job.command_hash,
      stage: "pre_execution"
    });
    try {
      await writeDurableFile(this.stageFile(job.resume_id), canonicalJson(stage));
      await syncDirectory(this.#stagesRoot);
    } catch (cause) {
      if (!isErrno(cause, "EEXIST")) throw cause;
      const existing = await this.readStage(job);
      if (existing === undefined) {
        throw queueCorruptionError("Native run resume stage disappeared after acceptance");
      }
    }
  }

  async readStage(
    job: NativeStudioQueuedResume
  ): Promise<NativeStudioRunResumeStage | undefined> {
    let handle;
    try {
      handle = await open(
        this.stageFile(job.resume_id),
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) return undefined;
      throw queueError("Native run resume stage is unavailable", cause);
    }
    try {
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile() || metadata.size > MAX_JOB_FILE_BYTES) {
        throw queueCorruptionError("Native run resume stage exceeds its read limit");
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
        throw queueCorruptionError("Native run resume stage changed while reading");
      }
      let raw: unknown;
      try {
        raw = JSON.parse(content.toString("utf8"));
      } catch (cause) {
        throw queueCorruptionError("Native run resume stage is not valid JSON", cause);
      }
      const stage = NativeStudioRunResumeStageSchema.safeParse(raw);
      if (
        !stage.success ||
        stage.data.resume_id !== job.resume_id ||
        !studioRunDigestsEqual(stage.data.command_hash, job.command_hash)
      ) {
        throw queueCorruptionError("Native run resume stage failed integrity validation");
      }
      return stage.data;
    } finally {
      await handle.close();
    }
  }

  async markEffectMayHaveOccurred(
    job: NativeStudioQueuedResume,
    nodeId: string
  ): Promise<void> {
    const current = await this.readStage(job);
    if (current?.stage === "effect_may_have_occurred") return;
    if (current === undefined) {
      throw queueCorruptionError("Native run resume stage is unavailable before effect execution");
    }
    const next = nativeStudioRunResumeStage({
      resumeId: job.resume_id,
      commandHash: job.command_hash,
      stage: "effect_may_have_occurred",
      effectNodeId: nodeId
    });
    const staging = path.join(
      this.#stagesRoot,
      `.creating-${job.resume_id}-${randomBytes(8).toString("hex")}`
    );
    try {
      await writeDurableFile(staging, canonicalJson(next));
      await rename(staging, this.stageFile(job.resume_id));
      await syncDirectory(this.#stagesRoot);
    } finally {
      await unlink(staging).catch((cause) => {
        if (!isErrno(cause, "ENOENT")) throw cause;
      });
    }
  }

  async listIds(): Promise<readonly string[]> {
    const ids = new Set<string>();
    await this.collectIds(this.#resumesRoot, ids);
    await this.collectIds(this.#identitiesRoot, ids);
    return [...ids].sort((left, right) => left.localeCompare(right));
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
    await unlink(this.stageFile(id)).catch((cause) => {
      if (!isErrno(cause, "ENOENT")) throw cause;
    });
    await syncDirectory(this.#stagesRoot);
    await unlink(this.identityFile(id)).catch((cause) => {
      if (!isErrno(cause, "ENOENT")) throw cause;
    });
    await syncDirectory(this.#identitiesRoot);
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
      const stage = this.stageFile(id);
      const quarantinedStage = path.join(
        this.#quarantineRoot,
        `${id}-stage-${randomBytes(8).toString("hex")}.json`
      );
      await rename(stage, quarantinedStage).catch((cause) => {
        if (!isErrno(cause, "ENOENT")) throw cause;
      });
      await syncDirectory(this.#stagesRoot);
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

  private stageFile(resumeId: string): string {
    return path.join(this.#stagesRoot, `${resumeId}.json`);
  }

  private identityFile(resumeId: string): string {
    return path.join(this.#identitiesRoot, `${resumeId}.json`);
  }

  private async ensureIdentity(
    job: NativeStudioQueuedResume
  ): Promise<NativeStudioRunResumeIdentity> {
    const identity = nativeStudioRunResumeIdentity({
      resumeId: job.resume_id,
      runId: job.run_id,
      interruptId: job.interrupt_id,
      commandHash: job.command_hash,
      acceptedAt: job.accepted_at
    });
    try {
      await writeDurableFile(this.identityFile(job.resume_id), canonicalJson(identity));
      await syncDirectory(this.#identitiesRoot);
      return identity;
    } catch (cause) {
      if (!isErrno(cause, "EEXIST")) throw cause;
    }
    return await this.readIdentity(job.resume_id);
  }

  private async readIdentityIfPresent(
    resumeId: string
  ): Promise<NativeStudioRunResumeIdentity | undefined> {
    try {
      await lstat(this.identityFile(resumeId));
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) return undefined;
      throw cause;
    }
    return await this.readIdentity(resumeId);
  }

  private async collectIds(root: string, ids: Set<string>): Promise<void> {
    const handle = await opendir(root);
    try {
      for await (const entry of handle) {
        if (
          (!entry.isFile() && !entry.isSymbolicLink()) ||
          !entry.name.endsWith(".json")
        ) continue;
        const parsed = RunOpaqueIdSchema.safeParse(entry.name.slice(0, -5));
        if (parsed.success) ids.add(parsed.data);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async removeOrphanStages(): Promise<void> {
    const handle = await opendir(this.#stagesRoot);
    try {
      for await (const entry of handle) {
        if (
          (!entry.isFile() && !entry.isSymbolicLink()) ||
          !entry.name.endsWith(".json")
        ) continue;
        const parsed = RunOpaqueIdSchema.safeParse(entry.name.slice(0, -5));
        if (!parsed.success) continue;
        const hasAuthority = await Promise.all([
          lstat(this.resumeFile(parsed.data)).then(() => true).catch((cause) => {
            if (isErrno(cause, "ENOENT")) return false;
            throw cause;
          }),
          lstat(this.identityFile(parsed.data)).then(() => true).catch((cause) => {
            if (isErrno(cause, "ENOENT")) return false;
            throw cause;
          })
        ]).then(([resume, identity]) => resume || identity);
        if (!hasAuthority) {
          await unlink(this.stageFile(parsed.data));
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    await syncDirectory(this.#stagesRoot);
  }
}
