import { StudioDigestSchema } from "../../contracts/digests.js";
import type {
  StudioBaseFile,
  StudioDependency,
  StudioDraftFileChange
} from "../../contracts/drafts.js";
import {
  studioPathKey,
  studioResourceKey,
  type StudioPath
} from "../../contracts/paths.js";
import {
  STUDIO_DRAFT_AUTHORING_LIMITS,
  type StudioDraftItem
} from "../../contracts/draft-authoring.js";
import {
  buildStudioDraftBundle,
  computeStudioBaseBundleHash,
  type StudioDraftBundle
} from "../drafts/authoring-bundles.js";
import { studioAuthoringContentDigest } from "../drafts/authoring-digests.js";
import { StudioDraftAuthoringError } from "../drafts/authoring-errors.js";
import type {
  StudioAuthoringSourceFile,
  StudioAuthoringSourcePort,
  StudioCatalogFingerprintPort,
  StudioResourceRevisionPort
} from "../drafts/authoring-ports.js";
import {
  isStudioEditableResourcePath
} from "../drafts/authoring-resource-paths.js";
import type {
  StudioDraftBlob,
  StudioDraftPersistencePort
} from "../drafts/persistence.js";
import { projectStudioDraftItem } from "../drafts/authoring-projection.js";
import {
  StudioDraftLifecycle,
  type StudioDraftLifecycleFailure
} from "../drafts/lifecycle.js";
import { StudioResourceHistoryError } from "./errors.js";
import { assertStudioHistoricalSnapshot } from "./snapshot-validation.js";
import type {
  StudioHistoricalDraftRestorePort,
  StudioHistoricalResourceFile,
  StudioHistoricalResourceSnapshot
} from "./ports.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type StudioHistoricalDraftRestoreOptions = {
  readonly drafts: StudioDraftPersistencePort;
  readonly source: StudioAuthoringSourcePort;
  readonly revisions: StudioResourceRevisionPort;
  readonly catalogs: StudioCatalogFingerprintPort;
  readonly now?: () => Date;
  readonly randomDraftId?: () => string;
};

function historyLifecycleError(
  failure: StudioDraftLifecycleFailure
): StudioResourceHistoryError {
  switch (failure.kind) {
    case "clock_invalid":
      return new StudioResourceHistoryError(
        "studio_history_resource_invalid",
        "The Studio history restore clock returned an invalid date",
        { cause: failure.cause }
      );
    case "catalog_fingerprint_invalid":
      return new StudioResourceHistoryError(
        "studio_history_resource_invalid",
        `The Studio ${failure.catalog} catalog fingerprint is invalid`
      );
    case "draft_missing":
      return new StudioResourceHistoryError(
        "studio_history_resource_invalid",
        "The historical restore draft no longer exists"
      );
    case "precondition_required":
    case "revision_conflict":
      return new StudioResourceHistoryError(
        "studio_history_resource_invalid",
        "The historical restore draft changed concurrently",
        { cause: failure.kind === "revision_conflict" ? failure.cause : undefined }
      );
    case "apply_unavailable":
      return new StudioResourceHistoryError(
        "studio_history_resource_invalid",
        "Historical restore drafts cannot be applied through this service"
      );
  }
}

type CurrentSourceFile = {
  readonly file: StudioPath;
  readonly content: string;
  readonly sha256: string;
  readonly mode: number;
};

function orderedPaths(paths: Iterable<StudioPath>): StudioPath[] {
  return [...paths].sort((left, right) =>
    studioPathKey(left).localeCompare(studioPathKey(right))
  );
}

function emptyCurrentBundle(
  resourceRevision: string | null
): StudioDraftBundle {
  return {
    resourceRevision,
    baseBundleHash: null,
    baseFiles: [],
    dependencies: [],
    allowedFiles: [],
    changes: [],
    blobs: []
  };
}

function historicalSourceFile(
  file: StudioHistoricalResourceFile
): StudioAuthoringSourceFile {
  return {
    content: file.content,
    sha256: file.sha256,
    mode: file.mode
  };
}

function targetOverlaySource(
  source: StudioAuthoringSourcePort,
  snapshot: StudioHistoricalResourceSnapshot
): StudioAuthoringSourcePort {
  const files = new Map(
    snapshot.files.map((file) => [studioPathKey(file.file), file])
  );
  return {
    async read(file, options) {
      const historical = files.get(studioPathKey(file));
      if (historical !== undefined) {
        if (historical.content.byteLength > options.maxBytes) {
          throw new StudioResourceHistoryError(
            "studio_history_source_too_large",
            "A historical resource file exceeds the authoring limit",
            {
              details: {
                resource: snapshot.resource,
                actualBytes: historical.content.byteLength,
                maxBytes: options.maxBytes
              }
            }
          );
        }
        return historicalSourceFile(historical);
      }
      // A file absent from the chosen revision stays absent. Dependencies are
      // the only reads delegated to current source.
      if (isStudioEditableResourcePath(snapshot.resource, file)) {
        return undefined;
      }
      return await source.read(file, options);
    }
  };
}

async function readCurrentCollision(
  source: StudioAuthoringSourcePort,
  file: StudioPath
): Promise<CurrentSourceFile | undefined> {
  let loaded: StudioAuthoringSourceFile | undefined;
  try {
    loaded = await source.read(file, {
      maxBytes: STUDIO_DRAFT_AUTHORING_LIMITS.maxContentBytes
    });
  } catch (cause) {
    throw new StudioResourceHistoryError(
      "studio_history_source_too_large",
      "A current source collision could not be read within Studio limits",
      { cause }
    );
  }
  if (loaded === undefined) {
    return undefined;
  }
  if (
    studioAuthoringContentDigest(loaded.content) !== loaded.sha256 ||
    !StudioDigestSchema.safeParse(loaded.sha256).success ||
    !Number.isInteger(loaded.mode) ||
    loaded.mode < 0 ||
    loaded.mode > 0o777
  ) {
    throw new StudioResourceHistoryError(
      "studio_history_resource_invalid",
      "Current source returned invalid collision metadata"
    );
  }
  let content: string;
  try {
    content = UTF8_DECODER.decode(loaded.content);
  } catch (cause) {
    throw new StudioResourceHistoryError(
      "studio_history_resource_invalid",
      "Studio history restore supports UTF-8 source files only",
      { cause }
    );
  }
  return {
    file,
    content,
    sha256: loaded.sha256,
    mode: loaded.mode
  };
}

async function currentBundle(
  options: Pick<StudioHistoricalDraftRestoreOptions, "source" | "revisions">,
  snapshot: StudioHistoricalResourceSnapshot
): Promise<StudioDraftBundle> {
  try {
    return await buildStudioDraftBundle(
      options,
      snapshot.resource,
      { mode: "existing" }
    );
  } catch (cause) {
    if (
      cause instanceof StudioDraftAuthoringError &&
      cause.code === "studio_draft_authoring_resource_not_found"
    ) {
      return emptyCurrentBundle(
        await options.revisions.current(snapshot.resource)
      );
    }
    throw cause;
  }
}

async function targetDependencies(
  options: Pick<StudioHistoricalDraftRestoreOptions, "source" | "revisions">,
  snapshot: StudioHistoricalResourceSnapshot
): Promise<readonly StudioDependency[]> {
  const bundle = await buildStudioDraftBundle(
    {
      source: targetOverlaySource(options.source, snapshot),
      revisions: options.revisions
    },
    snapshot.resource,
    { mode: "existing" }
  );
  return bundle.dependencies;
}

async function materializeCurrentBases(
  source: StudioAuthoringSourcePort,
  current: StudioDraftBundle,
  historicalFiles: readonly StudioHistoricalResourceFile[]
): Promise<{
  readonly baseFiles: readonly StudioBaseFile[];
  readonly blobs: readonly StudioDraftBlob[];
}> {
  const bases = new Map(
    current.baseFiles.map((base) => [studioPathKey(base.file), base])
  );
  const blobs = new Map(
    current.blobs.map((blob) => [blob.digest, blob])
  );
  for (const historical of historicalFiles) {
    const key = studioPathKey(historical.file);
    if (bases.has(key)) {
      continue;
    }
    const collision = await readCurrentCollision(source, historical.file);
    if (collision === undefined) {
      bases.set(key, {
        file: historical.file,
        sha256: null,
        content_ref: null,
        mode: null
      });
      continue;
    }
    bases.set(key, {
      file: collision.file,
      sha256: collision.sha256,
      content_ref: collision.sha256,
      mode: collision.mode
    });
    blobs.set(collision.sha256, {
      digest: collision.sha256,
      content: collision.content
    });
  }
  return {
    baseFiles: [...bases.values()].sort((left, right) =>
      studioPathKey(left.file).localeCompare(studioPathKey(right.file))
    ),
    blobs: [...blobs.values()]
  };
}

function restorationChanges(
  baseFiles: readonly StudioBaseFile[],
  historicalFiles: readonly StudioHistoricalResourceFile[]
): {
  readonly changes: readonly StudioDraftFileChange[];
  readonly blobs: readonly StudioDraftBlob[];
} {
  const historical = new Map(
    historicalFiles.map((file) => [studioPathKey(file.file), file])
  );
  const changes: StudioDraftFileChange[] = [];
  const blobs = new Map<string, StudioDraftBlob>();
  for (const base of baseFiles) {
    const target = historical.get(studioPathKey(base.file));
    if (target === undefined) {
      if (base.sha256 !== null) {
        changes.push({
          action: "delete",
          file: base.file,
          base_sha256: base.sha256
        });
      }
      continue;
    }
    if (base.sha256 === target.sha256 && base.mode === target.mode) {
      continue;
    }
    let content: string;
    try {
      content = UTF8_DECODER.decode(target.content);
    } catch (cause) {
      throw new StudioResourceHistoryError(
        "studio_history_resource_invalid",
        "Historical resource files must contain UTF-8 text",
        { cause }
      );
    }
    changes.push({
      action: "write",
      file: target.file,
      base_sha256: base.sha256,
      content_sha256: target.sha256,
      content_ref: target.sha256,
      mode: target.mode
    });
    blobs.set(target.sha256, { digest: target.sha256, content });
  }
  return { changes, blobs: [...blobs.values()] };
}

export class StudioHistoricalDraftRestore
  implements StudioHistoricalDraftRestorePort
{
  private readonly options: StudioHistoricalDraftRestoreOptions;
  private readonly lifecycle: StudioDraftLifecycle;

  constructor(options: StudioHistoricalDraftRestoreOptions) {
    this.options = options;
    this.lifecycle = new StudioDraftLifecycle({
      drafts: options.drafts,
      catalogs: options.catalogs,
      errors: historyLifecycleError,
      now: options.now,
      randomDraftId: options.randomDraftId
    });
  }

  async createFromHistory(
    snapshot: StudioHistoricalResourceSnapshot
  ): Promise<StudioDraftItem> {
    assertStudioHistoricalSnapshot(snapshot);
    const [current, dependencies] = await Promise.all([
      currentBundle(this.options, snapshot),
      targetDependencies(this.options, snapshot)
    ]);
    const materialized = await materializeCurrentBases(
      this.options.source,
      current,
      snapshot.files
    );
    const restore = restorationChanges(materialized.baseFiles, snapshot.files);
    if (restore.changes.length === 0) {
      throw new StudioResourceHistoryError(
        "studio_history_restore_noop",
        "The selected revision already matches current source",
        { details: { resource: snapshot.resource } }
      );
    }
    const allowedFiles = orderedPaths(
      materialized.baseFiles.map((base) => base.file)
    );
    const created = await this.lifecycle.create({
      primaryResource: snapshot.resource,
      resources: [snapshot.resource],
      resourceRevisions: {
        [studioResourceKey(snapshot.resource)]: current.resourceRevision
      },
      baseBundleHash: computeStudioBaseBundleHash(
        materialized.baseFiles,
        dependencies
      ),
      baseFiles: materialized.baseFiles,
      dependencies,
      allowedFiles,
      changes: restore.changes,
      blobs: [
        ...materialized.blobs,
        ...restore.blobs.filter(
          (blob) =>
            !materialized.blobs.some(
              (currentBlob) => currentBlob.digest === blob.digest
            )
        )
      ]
    });
    return await projectStudioDraftItem(this.options.drafts, created);
  }
}
