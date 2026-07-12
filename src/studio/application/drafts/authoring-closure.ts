import type { StudioDraftPatchRequest } from "../../contracts/draft-authoring.js";
import type {
  StudioBaseFile,
  StudioChangeSet,
  StudioDependency
} from "../../contracts/drafts.js";
import { studioPathKey } from "../../contracts/paths.js";
import {
  computeStudioDraftHash,
  parseAndAssertStudioChangeSet
} from "./change-set.js";
import type { StudioDraftBlob } from "./persistence.js";
import {
  buildStudioDraftBundle,
  computeStudioBaseBundleHash
} from "./authoring-bundles.js";
import {
  discoverStudioAgentResources,
  discoverStudioWorkflowResources
} from "./authoring-resource-discovery.js";
import {
  isStudioEditableResource,
  studioEditableDefinitionFile
} from "./authoring-resource-paths.js";
import { studioAuthoringContentDigest } from "./authoring-digests.js";
import { StudioDraftAuthoringError } from "./authoring-errors.js";
import type {
  StudioAuthoringSourcePort,
  StudioResourceRevisionPort
} from "./authoring-ports.js";

export type StudioDraftClosureRefresh = {
  readonly changeSet: StudioChangeSet;
  readonly blobs: readonly StudioDraftBlob[];
  readonly comparisonDraftHash: string;
};

const MAX_REPORTED_DIRTY_FILE_CONFLICTS = 3;

type StudioDefinitionWrite = {
  readonly content: string;
  readonly fieldPath: string;
};

function definitionWrite(
  changeSet: StudioChangeSet,
  patch: StudioDraftPatchRequest
): StudioDefinitionWrite | undefined {
  if (!isStudioEditableResource(changeSet.primary_resource)) {
    return undefined;
  }
  const definitionKey = studioPathKey(
    studioEditableDefinitionFile(changeSet.primary_resource)
  );
  const edits = (patch.edits ?? []).flatMap((edit, index) =>
    studioPathKey(edit.file) === definitionKey
      ? [{ edit, index }]
      : []
  );
  const candidate = edits.length === 1 ? edits[0] : undefined;
  return candidate?.edit.action === "write"
    ? {
        content: candidate.edit.content,
        fieldPath: `$.edits[${candidate.index}].content`
      }
    : undefined;
}

function assertNoRemovedDirtyFiles(
  current: StudioChangeSet,
  allowed: ReadonlySet<string>,
  fieldPath: string
): void {
  const removed = current.changes
    .map((change) => change.file)
    .filter((file) => !allowed.has(studioPathKey(file)))
    .sort((left, right) =>
      studioPathKey(left).localeCompare(studioPathKey(right))
  );
  if (removed.length === 0) return;

  const first = removed[0];
  if (first === undefined) return;
  const files = removed.slice(0, MAX_REPORTED_DIRTY_FILE_CONFLICTS);
  throw new StudioDraftAuthoringError(
    "studio_draft_authoring_dirty_file_conflict",
    "The definition change would remove dirty files from the draft closure",
    {
      details: {
        draftId: current.draft_id,
        file: first,
        files,
        fieldPath,
        actualEntries: removed.length
      }
    }
  );
}

function isCanonicalDefinition(
  changeSet: StudioChangeSet,
  source: string
): boolean {
  if (!isStudioEditableResource(changeSet.primary_resource)) {
    return false;
  }
  return changeSet.primary_resource.kind === "workflow"
    ? discoverStudioWorkflowResources(source).canonical
    : discoverStudioAgentResources(source).canonical;
}

function overlayDefinitionSource(
  source: StudioAuthoringSourcePort,
  definitionKey: string,
  content: string
): StudioAuthoringSourcePort {
  const bytes = Buffer.from(content, "utf8");
  const sha256 = studioAuthoringContentDigest(bytes);
  return {
    async read(file, options) {
      if (studioPathKey(file) !== definitionKey) {
        return await source.read(file, options);
      }
      if (bytes.byteLength > options.maxBytes) {
        throw new Error("Studio definition overlay exceeds its read limit");
      }
      return { content: bytes, sha256, mode: 0o644 };
    }
  };
}

function mergeBaseFiles(
  current: StudioChangeSet,
  desired: readonly StudioBaseFile[]
): readonly StudioBaseFile[] {
  const currentByPath = new Map(
    current.base_files.map((base) => [studioPathKey(base.file), base])
  );
  return desired.map(
    (base) => currentByPath.get(studioPathKey(base.file)) ?? base
  );
}

function mergeDependencies(
  current: StudioChangeSet,
  desired: readonly StudioDependency[]
): readonly StudioDependency[] {
  const currentByPath = new Map(
    current.dependencies.map((dependency) => [
      studioPathKey(dependency.file),
      dependency
    ])
  );
  return desired.map(
    (dependency) =>
      currentByPath.get(studioPathKey(dependency.file)) ?? dependency
  );
}

export async function refreshStudioDraftClosure(
  options: {
    readonly source: StudioAuthoringSourcePort;
    readonly revisions: StudioResourceRevisionPort;
  },
  current: StudioChangeSet,
  patch: StudioDraftPatchRequest
): Promise<StudioDraftClosureRefresh> {
  const definitionWriteCandidate = definitionWrite(current, patch);
  if (
    definitionWriteCandidate === undefined ||
    !isStudioEditableResource(current.primary_resource) ||
    !isCanonicalDefinition(current, definitionWriteCandidate.content)
  ) {
    return {
      changeSet: current,
      blobs: [],
      comparisonDraftHash: current.draft_hash
    };
  }

  const definition = studioEditableDefinitionFile(current.primary_resource);
  const bundle = await buildStudioDraftBundle(
    {
      source: overlayDefinitionSource(
        options.source,
        studioPathKey(definition),
        definitionWriteCandidate.content
      ),
      revisions: options.revisions
    },
    current.primary_resource,
    { mode: "existing" }
  );
  const allowed = new Set(bundle.allowedFiles.map(studioPathKey));
  assertNoRemovedDirtyFiles(
    current,
    allowed,
    definitionWriteCandidate.fieldPath
  );
  const baseFiles = mergeBaseFiles(current, bundle.baseFiles);
  const dependencies = mergeDependencies(current, bundle.dependencies);
  const changes = current.changes;
  const baseBundleHash =
    current.base_bundle_hash === null
      ? null
      : computeStudioBaseBundleHash(baseFiles, dependencies);
  const withoutHash = {
    ...current,
    base_bundle_hash: baseBundleHash,
    base_files: [...baseFiles],
    dependencies: [...dependencies],
    allowed_files: [...bundle.allowedFiles],
    changes: [...changes]
  };
  const refreshed = parseAndAssertStudioChangeSet({
    ...withoutHash,
    draft_hash: computeStudioDraftHash(withoutHash)
  });
  const contentRefs = new Set(
    baseFiles.flatMap((base) =>
      base.content_ref === null ? [] : [base.content_ref]
    )
  );
  return {
    changeSet: refreshed,
    blobs: bundle.blobs.filter((blob) => contentRefs.has(blob.digest)),
    comparisonDraftHash: current.draft_hash
  };
}
