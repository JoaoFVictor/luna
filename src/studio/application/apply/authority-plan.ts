import type { StudioDraftValidationService } from "../validation/draft-validation.js";
import { assertStudioChangeSetIntegrity } from "../drafts/change-set.js";
import type { StudioDraftPersistencePort } from "../drafts/persistence.js";
import type {
  StudioApplyConflict,
  StudioApplyFileDiff
} from "../../contracts/apply.js";
import type {
  StudioChangeSet,
  StudioDraftFileChange
} from "../../contracts/drafts.js";
import {
  studioPathKey,
  studioResourceKey
} from "../../contracts/paths.js";
import { assertSameStudioApplyValue } from "./assertions.js";
import { projectStudioApplyDiff } from "./diff.js";
import {
  studioApplyBytesDigest,
  studioApplyValueDigest
} from "./digests.js";
import { StudioApplyError } from "./errors.js";
import {
  StudioApplyReadBudget,
  type StudioApplyLimits
} from "./limits.js";
import type {
  StudioApplyGuard,
  StudioApplyPlanBinding,
  StudioApplySourceFile,
  StudioApplySourcePort,
  StudioApplyTransactionEntry,
  StudioStoredApplyPlan
} from "./ports.js";

export type StudioApplyAuthorityPlan = {
  readonly stored: StudioStoredApplyPlan;
  readonly diff: readonly StudioApplyFileDiff[];
  readonly conflicts: readonly StudioApplyConflict[];
  readonly entries: readonly StudioApplyTransactionEntry[];
  readonly guards: readonly StudioApplyGuard[];
};

export type StudioApplyAuthorityPlannerOptions = {
  readonly drafts: StudioDraftPersistencePort;
  readonly source: StudioApplySourcePort;
  readonly validation: Pick<StudioDraftValidationService, "validate">;
  readonly technicalCatalogFingerprint: () => Promise<string> | string;
  readonly compilerContractVersion: string;
  readonly limits: StudioApplyLimits;
};

function ordered<T>(
  values: readonly T[],
  key: (value: T) => string
): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

function expectedConflictKind(
  expected: string | null,
  actual: string | null
): StudioApplyConflict["kind"] {
  if (expected === null) return "created";
  if (actual === null) return "deleted";
  return "modified";
}

export class StudioApplyAuthorityPlanner {
  readonly #drafts: StudioDraftPersistencePort;
  readonly #source: StudioApplySourcePort;
  readonly #validation: Pick<StudioDraftValidationService, "validate">;
  readonly #technicalCatalogFingerprint: () => Promise<string> | string;
  readonly #compilerContractVersion: string;
  readonly #limits: StudioApplyLimits;

  constructor(options: StudioApplyAuthorityPlannerOptions) {
    this.#drafts = options.drafts;
    this.#source = options.source;
    this.#validation = options.validation;
    this.#technicalCatalogFingerprint = options.technicalCatalogFingerprint;
    this.#compilerContractVersion = options.compilerContractVersion;
    this.#limits = options.limits;
  }

  async build(changeSet: StudioChangeSet): Promise<StudioApplyAuthorityPlan> {
    assertStudioChangeSetIntegrity(changeSet);
    this.#assertCollectionLimits(changeSet);
    await this.#assertCatalogAuthority(changeSet);

    const budget = new StudioApplyReadBudget(this.#limits);
    const source = new Map<string, StudioApplySourceFile | undefined>();
    const conflicts: StudioApplyConflict[] = [];
    const expectedFiles = [
      ...changeSet.base_files.map((file) => ({
        file: file.file,
        sha256: file.sha256,
        mode: file.mode
      })),
      ...changeSet.dependencies.map((file) => ({
        file: file.file,
        sha256: file.sha256,
        mode: undefined
      }))
    ];
    for (const expected of ordered(
      expectedFiles,
      (item) => studioPathKey(item.file)
    )) {
      const current = await this.#source.read(expected.file, {
        maxBytes: budget.nextLimit(expected.file)
      });
      budget.account(expected.file, current?.content.byteLength ?? 0);
      source.set(studioPathKey(expected.file), current);
      const actual = current?.sha256 ?? null;
      const actualMode = current?.mode ?? null;
      if (
        actual !== expected.sha256 ||
        (expected.mode !== undefined && actualMode !== expected.mode)
      ) {
        conflicts.push({
          file: expected.file,
          kind: expectedConflictKind(expected.sha256, actual),
          expected_sha256: expected.sha256,
          actual_sha256: actual,
          ...(expected.mode === undefined
            ? {}
            : {
                expected_mode: expected.mode,
                actual_mode: actualMode
              })
        });
      }
    }

    const { entries, diff } = await this.#buildEntriesAndDiff(
      changeSet,
      source,
      conflicts,
      budget
    );
    const binding = this.#buildBinding(changeSet, diff);
    const expectedResourceRevisions =
      conflicts.length === 0
        ? await this.#validateAndCompile(changeSet)
        : {};
    return {
      stored: { binding, expectedResourceRevisions },
      diff,
      conflicts,
      entries,
      guards: ordered(expectedFiles, (item) => studioPathKey(item.file))
    };
  }

  #assertCollectionLimits(changeSet: StudioChangeSet): void {
    if (changeSet.changes.length === 0) {
      throw new StudioApplyError(
        "studio_apply_source_invalid",
        "A Studio apply plan must contain at least one file change",
        { details: { draftId: changeSet.draft_id } }
      );
    }
    if (
      changeSet.base_files.length + changeSet.dependencies.length >
        this.#limits.maxFiles ||
      changeSet.changes.length > this.#limits.maxFiles ||
      changeSet.allowed_files.length > this.#limits.maxFiles ||
      changeSet.resources.length > this.#limits.maxFiles
    ) {
      throw new StudioApplyError(
        "studio_apply_source_too_large",
        "Studio apply collections exceed the configured file count limit",
        { details: { draftId: changeSet.draft_id } }
      );
    }
  }

  async #assertCatalogAuthority(changeSet: StudioChangeSet): Promise<void> {
    const currentCatalog = await this.#technicalCatalogFingerprint();
    if (currentCatalog !== changeSet.technical_catalog_fingerprint) {
      throw new StudioApplyError(
        "studio_apply_plan_stale",
        "The technical capability catalog changed after the draft was created",
        { details: { draftId: changeSet.draft_id } }
      );
    }
  }

  async #buildEntriesAndDiff(
    changeSet: StudioChangeSet,
    source: ReadonlyMap<string, StudioApplySourceFile | undefined>,
    conflicts: readonly StudioApplyConflict[],
    budget: StudioApplyReadBudget
  ): Promise<{
    readonly entries: StudioApplyTransactionEntry[];
    readonly diff: StudioApplyFileDiff[];
  }> {
    const entries: StudioApplyTransactionEntry[] = [];
    const diff: StudioApplyFileDiff[] = [];
    let diffBytesRemaining = this.#limits.maxDiffTotalBytes;
    for (const change of ordered(
      changeSet.changes,
      (item) => studioPathKey(item.file)
    )) {
      const before = source.get(studioPathKey(change.file));
      const entry = await this.#buildEntry(changeSet, change, before, budget);
      entries.push(entry);
      if (
        conflicts.length === 0 &&
        entry.action === "write" &&
        entry.beforeSha256 === entry.afterSha256 &&
        (entry.mode ?? before?.mode ?? 0o644) === (before?.mode ?? 0o644)
      ) {
        throw new StudioApplyError(
          "studio_apply_source_invalid",
          "Studio apply contains a no-op file write",
          { details: { draftId: changeSet.draft_id, file: change.file } }
        );
      }
      const maxTextBytes = Math.min(
        this.#limits.maxDiffFileBytes,
        diffBytesRemaining
      );
      const projected = projectStudioApplyDiff({
        file: entry.file,
        kind:
          entry.action === "delete"
            ? "deleted"
            : entry.beforeSha256 === null
              ? "created"
              : "modified",
        before: before?.content,
        after: entry.content,
        beforeSha256: before?.sha256 ?? null,
        afterSha256: entry.afterSha256,
        beforeMode: before?.mode ?? null,
        afterMode: entry.action === "write" ? (entry.mode ?? 0o644) : null,
        maxTextBytes
      });
      diff.push(projected);
      diffBytesRemaining -= Buffer.byteLength(projected.textual_diff, "utf8");
    }
    return { entries, diff };
  }

  #buildBinding(
    changeSet: StudioChangeSet,
    diff: readonly StudioApplyFileDiff[]
  ): StudioApplyPlanBinding {
    const bindingWithoutDigest = {
      draftId: changeSet.draft_id,
      recordRevision: changeSet.record_revision,
      contentRevision: changeSet.content_revision,
      layoutRevision: changeSet.layout_revision,
      draftHash: changeSet.draft_hash,
      baseBundleHash: changeSet.base_bundle_hash,
      baseFiles: ordered(
        changeSet.base_files.map((file) => ({
          file: file.file,
          sha256: file.sha256,
          mode: file.mode
        })),
        (file) => studioPathKey(file.file)
      ),
      dependencies: ordered(changeSet.dependencies, (dependency) =>
        studioPathKey(dependency.file)
      ),
      resourceRevisions: Object.fromEntries(
        Object.entries(changeSet.resource_revisions).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
      technicalCatalogFingerprint: changeSet.technical_catalog_fingerprint,
      compilerContractVersion: this.#compilerContractVersion,
      diffDigest: studioApplyValueDigest(diff)
    };
    return {
      ...bindingWithoutDigest,
      planDigest: studioApplyValueDigest(bindingWithoutDigest)
    };
  }

  async #buildEntry(
    changeSet: StudioChangeSet,
    change: StudioDraftFileChange,
    before: StudioApplySourceFile | undefined,
    budget: StudioApplyReadBudget
  ): Promise<StudioApplyTransactionEntry> {
    if (change.action === "delete") {
      return {
        file: change.file,
        action: "delete",
        beforeSha256: change.base_sha256,
        beforeMode: before?.mode ?? null,
        afterSha256: null
      };
    }
    let content: string;
    try {
      content = await this.#drafts.getBlob(
        changeSet.draft_id,
        change.content_ref,
        { maxBytes: budget.nextLimit(change.file) }
      );
    } catch (cause) {
      throw new StudioApplyError(
        "studio_apply_source_invalid",
        "Unable to read a bounded Studio draft blob for apply",
        { cause, details: { draftId: changeSet.draft_id, file: change.file } }
      );
    }
    const bytes = Buffer.from(content, "utf8");
    budget.account(change.file, bytes.byteLength);
    if (studioApplyBytesDigest(bytes) !== change.content_sha256) {
      throw new StudioApplyError(
        "studio_apply_source_invalid",
        "Studio draft blob hash does not match its change set",
        { details: { draftId: changeSet.draft_id, file: change.file } }
      );
    }
    return {
      file: change.file,
      action: "write",
      beforeSha256: change.base_sha256,
      beforeMode: before?.mode ?? null,
      afterSha256: change.content_sha256,
      content: bytes,
      mode: change.mode ?? before?.mode ?? 0o644
    };
  }

  async #validateAndCompile(
    changeSet: StudioChangeSet
  ): Promise<Readonly<Record<string, string>>> {
    let validation;
    try {
      validation = await this.#validation.validate(changeSet, {
        compile: true
      });
    } catch (cause) {
      throw new StudioApplyError(
        "studio_apply_validation_failed",
        "Canonical Studio validation failed before apply",
        { cause, details: { draftId: changeSet.draft_id } }
      );
    }
    if (
      validation.status !== "valid" ||
      !validation.compiled ||
      validation.draft_hash !== changeSet.draft_hash ||
      validation.record_revision !== changeSet.record_revision
    ) {
      throw new StudioApplyError(
        "studio_apply_validation_failed",
        "Canonical Studio validation did not authorize this draft revision",
        { details: { draftId: changeSet.draft_id } }
      );
    }
    const revisions = new Map<string, string>();
    for (const resource of validation.resources) {
      const key = studioResourceKey(resource.resource);
      if (resource.revision === undefined || revisions.has(key)) {
        throw new StudioApplyError(
          "studio_apply_validation_failed",
          "Canonical validation omitted or duplicated a resource revision",
          { details: { draftId: changeSet.draft_id } }
        );
      }
      revisions.set(key, resource.revision);
    }
    assertSameStudioApplyValue(
      [...revisions.keys()].sort(),
      changeSet.resources.map(studioResourceKey).sort(),
      "studio_apply_validation_failed",
      "Canonical validation did not cover the exact draft resource set"
    );
    return Object.fromEntries(revisions);
  }
}
