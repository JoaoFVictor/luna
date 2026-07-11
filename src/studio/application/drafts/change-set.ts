import {
  canonicalJson,
  sha256Digest
} from "../../../core/workflow/definition-digests.js";
import {
  StudioChangeSetSchema,
  type StudioBaseFile,
  type StudioChangeSet,
  type StudioDependency,
  type StudioDraftFileChange
} from "../../contracts/drafts.js";
import {
  studioPathKey,
  studioResourceKey,
  type StudioPath,
  type StudioResourceRef
} from "../../contracts/paths.js";

export type CreateStudioChangeSetInput = {
  readonly draftId: string;
  readonly primaryResource: StudioResourceRef;
  readonly resources: readonly StudioResourceRef[];
  readonly resourceRevisions: Readonly<Record<string, string | null>>;
  readonly baseBundleHash: string | null;
  readonly technicalCatalogFingerprint: string;
  readonly presentationCatalogFingerprint: string;
  readonly baseFiles: readonly StudioBaseFile[];
  readonly dependencies: readonly StudioDependency[];
  readonly allowedFiles: readonly StudioPath[];
  readonly changes?: readonly StudioDraftFileChange[];
  readonly now: string;
};

export type StudioChangeSetError = Error & {
  readonly code:
    | "draft_resource_duplicate"
    | "draft_primary_resource_missing"
    | "draft_resource_revision_mismatch"
    | "draft_file_duplicate"
    | "draft_file_not_allowed"
    | "draft_file_role_conflict"
    | "draft_base_content_mismatch"
    | "draft_change_base_mismatch"
    | "draft_noop_update"
    | "draft_hash_invalid";
};

function changeSetError(
  code: StudioChangeSetError["code"],
  message: string
): StudioChangeSetError {
  const error = new Error(message) as StudioChangeSetError;
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  return error;
}

function assertUnique<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  code: StudioChangeSetError["code"],
  label: string
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) {
      throw changeSetError(code, `Duplicate ${label}: ${key}`);
    }
    seen.add(key);
  }
}

function assertResourceRevisionKeys(changeSet: StudioChangeSet): void {
  const expected = new Set(changeSet.resources.map(studioResourceKey));
  const actual = new Set(Object.keys(changeSet.resource_revisions));
  const missing = [...expected].filter((key) => !actual.has(key));
  const unexpected = [...actual].filter((key) => !expected.has(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw changeSetError(
      "draft_resource_revision_mismatch",
      [
        "Resource revisions must exactly match draft resources",
        `missing: ${missing.sort().join(", ") || "none"}`,
        `unexpected: ${unexpected.sort().join(", ") || "none"}`
      ].join("; ")
    );
  }
}

function assertChangeBaseMatches(
  change: StudioDraftFileChange,
  baseFile: StudioBaseFile | undefined,
  key: string
): void {
  if (baseFile === undefined) {
    throw changeSetError(
      "draft_change_base_mismatch",
      `Changed file has no base file entry: ${key}`
    );
  }
  if (change.action === "delete" && baseFile.sha256 === null) {
    throw changeSetError(
      "draft_change_base_mismatch",
      `A new file cannot be deleted from a Studio draft: ${key}`
    );
  }
  if (change.base_sha256 !== baseFile.sha256) {
    throw changeSetError(
      "draft_change_base_mismatch",
      `Changed file base hash does not match its base file: ${key}`
    );
  }
}

function assertChangeSetInvariants(changeSet: StudioChangeSet): void {
  assertUnique(
    changeSet.resources,
    studioResourceKey,
    "draft_resource_duplicate",
    "resource"
  );
  const primaryKey = studioResourceKey(changeSet.primary_resource);
  if (
    !changeSet.resources.some(
      (resource) => studioResourceKey(resource) === primaryKey
    )
  ) {
    throw changeSetError(
      "draft_primary_resource_missing",
      `Primary resource ${primaryKey} is not present in resources`
    );
  }
  assertResourceRevisionKeys(changeSet);

  assertUnique(
    changeSet.base_files,
    (file) => studioPathKey(file.file),
    "draft_file_duplicate",
    "base file"
  );
  assertUnique(
    changeSet.dependencies,
    (file) => studioPathKey(file.file),
    "draft_file_duplicate",
    "dependency"
  );
  assertUnique(
    changeSet.allowed_files,
    studioPathKey,
    "draft_file_duplicate",
    "allowed file"
  );
  assertUnique(
    changeSet.changes,
    (change) => studioPathKey(change.file),
    "draft_file_duplicate",
    "change"
  );

  const allowed = new Set(changeSet.allowed_files.map(studioPathKey));
  const baseFiles = new Map(
    changeSet.base_files.map((file) => [studioPathKey(file.file), file])
  );
  const dependencies = new Set(
    changeSet.dependencies.map((file) => studioPathKey(file.file))
  );
  for (const baseFile of changeSet.base_files) {
    const key = studioPathKey(baseFile.file);
    if (!allowed.has(key)) {
      throw changeSetError(
        "draft_file_not_allowed",
        `Base file is not server-authorized for this draft: ${key}`
      );
    }
    if (dependencies.has(key)) {
      throw changeSetError(
        "draft_file_role_conflict",
        `File cannot be both a base file and dependency: ${key}`
      );
    }
    if (baseFile.sha256 !== baseFile.content_ref) {
      throw changeSetError(
        "draft_base_content_mismatch",
        `Base file content reference does not match its hash: ${key}`
      );
    }
  }

  for (const change of changeSet.changes) {
    const key = studioPathKey(change.file);
    if (!allowed.has(key)) {
      throw changeSetError(
        "draft_file_not_allowed",
        `Changed file is not server-authorized for this draft: ${key}`
      );
    }
    assertChangeBaseMatches(change, baseFiles.get(key), key);
  }
}

function byKey<T>(
  values: readonly T[],
  keyOf: (value: T) => string
): T[] {
  return [...values].sort((left, right) =>
    keyOf(left).localeCompare(keyOf(right))
  );
}

export function computeStudioDraftHash(
  changeSet: Omit<StudioChangeSet, "draft_hash">
): string {
  return sha256Digest({
    format_version: changeSet.format_version,
    primary_resource: changeSet.primary_resource,
    resources: byKey(changeSet.resources, studioResourceKey),
    resource_revisions: changeSet.resource_revisions,
    base_bundle_hash: changeSet.base_bundle_hash,
    technical_catalog_fingerprint:
      changeSet.technical_catalog_fingerprint,
    base_files: byKey(changeSet.base_files, (file) => studioPathKey(file.file)),
    dependencies: byKey(
      changeSet.dependencies,
      (dependency) => studioPathKey(dependency.file)
    ),
    allowed_files: byKey(changeSet.allowed_files, studioPathKey),
    changes: byKey(changeSet.changes, (change) => studioPathKey(change.file))
  });
}

export function assertStudioChangeSetIntegrity(
  changeSet: StudioChangeSet
): void {
  assertChangeSetInvariants(changeSet);
  if (changeSet.draft_hash !== computeStudioDraftHash(changeSet)) {
    throw changeSetError(
      "draft_hash_invalid",
      `Draft content hash is invalid: ${changeSet.draft_id}`
    );
  }
}

export function parseAndAssertStudioChangeSet(value: unknown): StudioChangeSet {
  const changeSet = StudioChangeSetSchema.parse(value);
  assertStudioChangeSetIntegrity(changeSet);
  return changeSet;
}

export function createStudioChangeSet(
  input: CreateStudioChangeSetInput
): StudioChangeSet {
  const changes = [...(input.changes ?? [])];
  const withoutHash: Omit<StudioChangeSet, "draft_hash"> = {
    format_version: 1,
    draft_id: input.draftId,
    record_revision: 1,
    content_revision: 1,
    layout_revision: 0,
    primary_resource: input.primaryResource,
    resources: [...input.resources],
    resource_revisions: { ...input.resourceRevisions },
    base_bundle_hash: input.baseBundleHash,
    technical_catalog_fingerprint: input.technicalCatalogFingerprint,
    presentation_catalog_fingerprint: input.presentationCatalogFingerprint,
    base_files: [...input.baseFiles],
    dependencies: [...input.dependencies],
    allowed_files: [...input.allowedFiles],
    changes,
    status: "dirty",
    created_at: input.now,
    updated_at: input.now
  };

  return parseAndAssertStudioChangeSet({
    ...withoutHash,
    draft_hash: computeStudioDraftHash(withoutHash)
  });
}

export function replaceStudioDraftContent(
  current: StudioChangeSet,
  changes: readonly StudioDraftFileChange[],
  now: string
): StudioChangeSet {
  const next: StudioChangeSet = {
    ...current,
    record_revision: current.record_revision + 1,
    content_revision: current.content_revision + 1,
    changes: [...changes],
    status: "dirty",
    updated_at: now
  };

  const draftHash = computeStudioDraftHash(next);
  if (draftHash === current.draft_hash) {
    throw changeSetError(
      "draft_noop_update",
      `Draft content is unchanged: ${current.draft_id}`
    );
  }

  return parseAndAssertStudioChangeSet({
    ...next,
    draft_hash: draftHash
  });
}

export function replaceStudioDraftLayout(
  current: StudioChangeSet,
  layout: StudioChangeSet["layout"],
  now: string
): StudioChangeSet {
  if (
    canonicalJson(layout ?? null) === canonicalJson(current.layout ?? null)
  ) {
    throw changeSetError(
      "draft_noop_update",
      `Draft layout is unchanged: ${current.draft_id}`
    );
  }
  return parseAndAssertStudioChangeSet({
    ...current,
    layout,
    record_revision: current.record_revision + 1,
    layout_revision: current.layout_revision + 1,
    updated_at: now
  });
}

export function replaceStudioDraftStatus(
  current: StudioChangeSet,
  status: StudioChangeSet["status"],
  now: string
): StudioChangeSet {
  if (status === current.status) {
    throw changeSetError(
      "draft_noop_update",
      `Draft status is already ${status}: ${current.draft_id}`
    );
  }
  return parseAndAssertStudioChangeSet({
    ...current,
    status,
    record_revision: current.record_revision + 1,
    updated_at: now
  });
}
