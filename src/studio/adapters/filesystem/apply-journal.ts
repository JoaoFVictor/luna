import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeFileAtomically } from "../../../core/filesystem/atomic-write.js";
import { canonicalJson } from "../../../core/workflow/definition-digests.js";
import { StudioApplyError } from "../../application/apply/errors.js";
import type {
  StudioApplyAttempt,
  StudioApplyJournalState,
  StudioApplyTransactionInput
} from "../../application/apply/ports.js";
import { StudioApplyResultSchema } from "../../contracts/apply.js";
import { StudioDigestSchema } from "../../contracts/digests.js";
import {
  StudioPathSchema,
  StudioResourceRefSchema,
  type StudioPath
} from "../../contracts/paths.js";

const JOURNAL_DIRECTORY_MODE = 0o700;
const JOURNAL_FILE_MODE = 0o600;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const DEFAULT_MAX_JOURNALS = 10_000;

const JournalStateSchema = z.enum([
  "prepared",
  "backed_up",
  "installing",
  "verifying",
  "committed",
  "rolling_back",
  "rolled_back",
  "recovery_required"
]);

const JournalEntrySchema = z
  .object({
    index: z.number().int().safe().nonnegative(),
    file: StudioPathSchema,
    action: z.enum(["write", "delete"]),
    before_sha256: StudioDigestSchema.nullable(),
    before_mode: z.number().int().min(0).max(0o777).nullable(),
    after_sha256: StudioDigestSchema.nullable(),
    mode: z.number().int().min(0).max(0o777).nullable()
  })
  .strict();

const JournalGuardSchema = z
  .object({
    file: StudioPathSchema,
    sha256: StudioDigestSchema.nullable(),
    mode: z.number().int().min(0).max(0o777).nullable().optional()
  })
  .strict();

const JournalVerificationSchema = z
  .object({
    resources: z.array(StudioResourceRefSchema).min(1),
    expected_resource_revisions: z.record(z.string(), StudioDigestSchema),
    technical_catalog_fingerprint: StudioDigestSchema,
    compiler_contract_version: z.string().min(1).max(256)
  })
  .strict();

export const StudioApplyJournalSchema = z
  .object({
    format_version: z.literal(1),
    operation_id: z.string().uuid(),
    state_revision: z.number().int().safe().positive(),
    state: JournalStateSchema,
    staging_complete: z.boolean(),
    draft_id: z.string().uuid(),
    record_revision: z.number().int().safe().positive(),
    draft_hash: StudioDigestSchema,
    request_hash: StudioDigestSchema,
    idempotency_key_hash: StudioDigestSchema,
    plan_token_hash: StudioDigestSchema,
    plan_digest: StudioDigestSchema,
    entries: z.array(JournalEntrySchema).min(1),
    guards: z.array(JournalGuardSchema),
    diff: StudioApplyResultSchema.shape.diff,
    created_directories: z.array(StudioPathSchema),
    verification: JournalVerificationSchema,
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
    result: StudioApplyResultSchema.optional()
  })
  .strict()
  .superRefine((journal, context) => {
    if ((journal.state === "committed") !== (journal.result !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only a committed apply journal may contain its final result",
        path: ["result"]
      });
    }
  });
export type StudioApplyJournal = z.infer<typeof StudioApplyJournalSchema>;

const TRANSITIONS: Readonly<Record<StudioApplyJournalState, readonly StudioApplyJournalState[]>> = {
  prepared: ["prepared", "backed_up", "rolling_back", "recovery_required"],
  backed_up: ["installing", "rolling_back", "recovery_required"],
  installing: ["verifying", "rolling_back", "recovery_required"],
  verifying: ["committed", "rolling_back", "recovery_required"],
  committed: [],
  rolling_back: ["rolled_back", "recovery_required"],
  rolled_back: [],
  recovery_required: ["rolling_back", "recovery_required"]
};

export type FileSystemStudioApplyJournalOptions = {
  readonly projectRoot: string;
  readonly now?: () => number;
  readonly maxJournals?: number;
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

async function ensureDirectory(
  directory: string,
  enforcePrivate: boolean
): Promise<void> {
  let created = false;
  try {
    await mkdir(directory, { mode: JOURNAL_DIRECTORY_MODE });
    created = true;
  } catch (cause) {
    if (!isErrno(cause, "EEXIST")) {
      throw cause;
    }
  }
  const entry = await lstat(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new StudioApplyError(
      "studio_apply_journal_invalid",
      "Studio apply journal storage must use real directories"
    );
  }
  if (enforcePrivate) {
    await chmod(directory, JOURNAL_DIRECTORY_MODE);
  }
  await syncDirectory(directory);
  if (created) {
    await syncDirectory(path.dirname(directory));
  }
}

function journalText(journal: StudioApplyJournal): string {
  return `${canonicalJson(journal)}\n`;
}

async function readJournalFile(filePath: string): Promise<Buffer | undefined> {
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
    if (!metadata.isFile() || metadata.size > MAX_JOURNAL_BYTES) {
      throw new StudioApplyError(
        "studio_apply_journal_invalid",
        "Studio apply journal is not a bounded regular file"
      );
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_JOURNAL_BYTES) {
      throw new StudioApplyError(
        "studio_apply_journal_invalid",
        "Studio apply journal exceeds its byte limit"
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export class FileSystemStudioApplyJournal {
  private readonly projectRoot: string;
  private readonly journalRoot: string;
  private readonly now: () => number;
  private readonly maxJournals: number;

  constructor(options: FileSystemStudioApplyJournalOptions) {
    if (options.projectRoot.trim() === "") {
      throw new StudioApplyError(
        "studio_apply_config_invalid",
        "Studio apply journal project root cannot be blank"
      );
    }
    this.projectRoot = path.resolve(options.projectRoot);
    this.journalRoot = path.join(
      this.projectRoot,
      ".luna",
      "studio",
      "apply-journal"
    );
    this.now = options.now ?? Date.now;
    this.maxJournals = options.maxJournals ?? DEFAULT_MAX_JOURNALS;
    if (!Number.isSafeInteger(this.maxJournals) || this.maxJournals < 1) {
      throw new StudioApplyError(
        "studio_apply_config_invalid",
        "Studio apply journal count limit must be a positive safe integer"
      );
    }
  }

  async create(input: StudioApplyTransactionInput): Promise<StudioApplyJournal> {
    await this.ensureStorage();
    const now = this.timestamp();
    const journal = StudioApplyJournalSchema.parse({
      format_version: 1,
      operation_id: input.operationId,
      state_revision: 1,
      state: "prepared",
      staging_complete: false,
      draft_id: input.draftId,
      record_revision: input.recordRevision,
      draft_hash: input.draftHash,
      request_hash: input.requestHash,
      idempotency_key_hash: input.idempotencyKeyHash,
      plan_token_hash: input.planTokenHash,
      plan_digest: input.planDigest,
      entries: input.entries.map((entry, index) => ({
        index,
        file: entry.file,
        action: entry.action,
        before_sha256: entry.beforeSha256,
        before_mode: entry.beforeMode,
        after_sha256: entry.afterSha256,
        mode: entry.mode ?? null
      })),
      guards: input.guards.map((guard) => ({
        file: guard.file,
        sha256: guard.sha256,
        ...(guard.mode === undefined ? {} : { mode: guard.mode })
      })),
      diff: input.diff,
      created_directories: [],
      verification: {
        resources: input.verification.resources,
        expected_resource_revisions:
          input.verification.expectedResourceRevisions,
        technical_catalog_fingerprint:
          input.verification.technicalCatalogFingerprint,
        compiler_contract_version:
          input.verification.compilerContractVersion
      },
      created_at: now,
      updated_at: now
    });
    const target = this.journalPath(journal.operation_id);
    try {
      const existing = await lstat(target);
      if (existing) {
        throw new StudioApplyError(
          "studio_apply_journal_invalid",
          "Studio apply operation id already exists",
          { details: { operationId: journal.operation_id } }
        );
      }
    } catch (cause) {
      if (!isErrno(cause, "ENOENT")) {
        throw cause;
      }
    }
    await this.write(journal);
    return journal;
  }

  async update(
    current: StudioApplyJournal,
    input: {
      readonly state?: StudioApplyJournalState;
      readonly stagingComplete?: boolean;
      readonly createdDirectories?: readonly StudioPath[];
      readonly result?: StudioApplyJournal["result"];
    }
  ): Promise<StudioApplyJournal> {
    const state = input.state ?? current.state;
    if (
      state !== current.state &&
      !TRANSITIONS[current.state].includes(state)
    ) {
      throw new StudioApplyError(
        "studio_apply_journal_invalid",
        `Invalid Studio apply journal transition from ${current.state} to ${state}`,
        { details: { operationId: current.operation_id, state: current.state } }
      );
    }
    const next = StudioApplyJournalSchema.parse({
      ...current,
      state_revision: current.state_revision + 1,
      state,
      staging_complete: input.stagingComplete ?? current.staging_complete,
      created_directories:
        input.createdDirectories ?? current.created_directories,
      updated_at: this.timestamp(),
      ...(input.result === undefined ? {} : { result: input.result })
    });
    await this.write(next);
    return next;
  }

  async get(operationId: string): Promise<StudioApplyJournal | undefined> {
    await this.ensureStorage();
    const target = this.journalPath(operationId);
    let bytes: Buffer | undefined;
    try {
      bytes = await readJournalFile(target);
    } catch (cause) {
      if (cause instanceof StudioApplyError) {
        throw cause;
      }
      throw new StudioApplyError(
        "studio_apply_io_failed",
        "Unable to read a Studio apply journal",
        { cause, details: { operationId } }
      );
    }
    if (bytes === undefined) {
      return undefined;
    }
    try {
      return StudioApplyJournalSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch (cause) {
      throw new StudioApplyError(
        "studio_apply_journal_invalid",
        "Studio apply journal is corrupt",
        { cause, details: { operationId } }
      );
    }
  }

  async list(): Promise<readonly StudioApplyJournal[]> {
    await this.ensureStorage();
    const entries = await readdir(this.journalRoot, { withFileTypes: true });
    if (
      entries.some(
        (entry) => entry.name.endsWith(".json") && !entry.isFile()
      )
    ) {
      throw new StudioApplyError(
        "studio_apply_journal_invalid",
        "Studio apply journal contains a non-file journal entry"
      );
    }
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .sort();
    if (names.length > this.maxJournals) {
      throw new StudioApplyError(
        "studio_apply_journal_invalid",
        "Studio apply journal count exceeds its configured limit"
      );
    }
    const journals: StudioApplyJournal[] = [];
    for (const name of names) {
      const journal = await this.get(name);
      if (journal !== undefined) {
        journals.push(journal);
      }
    }
    return journals;
  }

  async findByIdempotencyKeyHash(
    digest: string
  ): Promise<StudioApplyAttempt | undefined> {
    const matches = (await this.list()).filter(
      (journal) => journal.idempotency_key_hash === digest
    );
    if (matches.length > 1) {
      throw new StudioApplyError(
        "studio_apply_journal_invalid",
        "Duplicate Studio apply idempotency records were found"
      );
    }
    const journal = matches[0];
    return journal === undefined
      ? undefined
      : {
          operationId: journal.operation_id,
          requestHash: journal.request_hash,
          state: journal.state,
          ...(journal.result === undefined ? {} : { result: journal.result })
        };
  }

  private async write(journal: StudioApplyJournal): Promise<void> {
    await this.ensureStorage();
    const text = journalText(journal);
    if (Buffer.byteLength(text, "utf8") > MAX_JOURNAL_BYTES) {
      throw new StudioApplyError(
        "studio_apply_journal_invalid",
        "Studio apply journal exceeds its byte limit",
        { details: { operationId: journal.operation_id } }
      );
    }
    try {
      await writeFileAtomically(this.journalPath(journal.operation_id), text, {
        mode: JOURNAL_FILE_MODE,
        errorCode: "studio_apply_io_failed",
        commitAmbiguousErrorCode: "studio_apply_recovery_required",
        errorLabel: "Studio apply journal write"
      });
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        "commitState" in cause &&
        cause.commitState === "commit_ambiguous"
      ) {
        try {
          const persisted = await readJournalFile(
            this.journalPath(journal.operation_id)
          );
          if (persisted?.toString("utf8") === text) {
            return;
          }
        } catch {
          // The caller must recover from durable filesystem evidence.
        }
        throw new StudioApplyError(
          "studio_apply_recovery_required",
          "Studio apply journal durability is ambiguous",
          { cause, details: { operationId: journal.operation_id } }
        );
      }
      throw new StudioApplyError(
        "studio_apply_io_failed",
        "Unable to durably write a Studio apply journal",
        { cause, details: { operationId: journal.operation_id } }
      );
    }
  }

  private journalPath(operationId: string): string {
    if (!z.string().uuid().safeParse(operationId).success) {
      throw new StudioApplyError(
        "studio_apply_journal_invalid",
        "Studio apply operation id is invalid"
      );
    }
    return path.join(this.journalRoot, `${operationId}.json`);
  }

  private timestamp(): string {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new StudioApplyError(
        "studio_apply_config_invalid",
        "Studio apply journal clock must return a non-negative safe integer"
      );
    }
    return new Date(value).toISOString();
  }

  private async ensureStorage(): Promise<void> {
    const project = await lstat(this.projectRoot);
    if (project.isSymbolicLink() || !project.isDirectory()) {
      throw new StudioApplyError(
        "studio_apply_journal_invalid",
        "Studio apply journal project root must be a real directory"
      );
    }
    if ((await realpath(this.projectRoot)) !== this.projectRoot) {
      throw new StudioApplyError(
        "studio_apply_journal_invalid",
        "Studio apply journal project root must be physically resolved"
      );
    }
    const luna = path.join(this.projectRoot, ".luna");
    const studio = path.join(luna, "studio");
    await ensureDirectory(luna, false);
    await ensureDirectory(studio, true);
    await ensureDirectory(this.journalRoot, true);
  }
}
