import { studioAuthoringContentDigest } from "../drafts/authoring-digests.js";
import {
  isStudioEditableResourcePath,
  studioEditableDefinitionFile
} from "../drafts/authoring-resource-paths.js";
import { StudioDigestSchema } from "../../contracts/digests.js";
import { StudioPathSchema, studioPathKey } from "../../contracts/paths.js";
import {
  STUDIO_RESOURCE_HISTORY_LIMITS,
  StudioGitRevisionIdSchema,
  StudioHistoryResourceSchema,
  type StudioGitRevisionId,
  type StudioHistoryResource
} from "../../contracts/resource-history.js";
import { StudioResourceHistoryError } from "./errors.js";
import type { StudioHistoricalResourceSnapshot } from "./ports.js";

const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".netrc",
  "auth.json",
  "credentials.json",
  "id_rsa",
  "id_ed25519"
]);
const SENSITIVE_EXTENSIONS = new Set([
  ".key",
  ".pem",
  ".p12",
  ".pfx",
  ".kdbx"
]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

type ExpectedSnapshotBinding = {
  readonly resource: StudioHistoryResource;
  readonly revisionId: StudioGitRevisionId;
};

function invalidSnapshot(
  resource: StudioHistoryResource | undefined,
  message: string
): StudioResourceHistoryError {
  return new StudioResourceHistoryError(
    "studio_history_resource_invalid",
    message,
    resource === undefined ? {} : { details: { resource } }
  );
}

function oversizedSnapshot(
  resource: StudioHistoryResource,
  details: {
    readonly actualBytes?: number;
    readonly maxBytes?: number;
    readonly actualFiles?: number;
    readonly maxFiles?: number;
  }
): StudioResourceHistoryError {
  return new StudioResourceHistoryError(
    "studio_history_source_too_large",
    "The historical resource snapshot exceeds Studio limits",
    {
      details: {
        resource,
        ...details
      }
    }
  );
}

export function isStudioHistorySensitivePath(filePath: string): boolean {
  const segments = filePath.split("/");
  const basename = segments.at(-1)?.toLowerCase() ?? "";
  const extensionIndex = basename.lastIndexOf(".");
  const extension = extensionIndex < 0 ? "" : basename.slice(extensionIndex);
  return (
    segments.some((segment) => segment.startsWith(".")) ||
    basename.startsWith(".env.") ||
    SENSITIVE_BASENAMES.has(basename) ||
    SENSITIVE_EXTENSIONS.has(extension)
  );
}

/**
 * Treat every history port as untrusted input. A valid snapshot is bound to
 * one exact entity and commit and contains only canonical, digest-verified
 * regular text resources within the shared history budget.
 */
export function assertStudioHistoricalSnapshot(
  snapshot: StudioHistoricalResourceSnapshot,
  expected?: ExpectedSnapshotBinding
): void {
  const resource = StudioHistoryResourceSchema.safeParse(snapshot.resource);
  const revision = StudioGitRevisionIdSchema.safeParse(snapshot.revisionId);
  if (!resource.success || !revision.success) {
    throw invalidSnapshot(
      expected?.resource,
      "Historical snapshot identity is invalid"
    );
  }
  if (
    expected !== undefined &&
    (resource.data.kind !== expected.resource.kind ||
      resource.data.id !== expected.resource.id ||
      revision.data !== expected.revisionId)
  ) {
    throw invalidSnapshot(
      expected.resource,
      "Historical storage returned a snapshot for a different resource or revision"
    );
  }
  if (snapshot.files.length === 0) {
    throw invalidSnapshot(
      resource.data,
      "Historical storage returned an empty entity snapshot"
    );
  }
  if (
    snapshot.files.length > STUDIO_RESOURCE_HISTORY_LIMITS.maxSnapshotFiles
  ) {
    throw oversizedSnapshot(resource.data, {
      actualFiles: snapshot.files.length,
      maxFiles: STUDIO_RESOURCE_HISTORY_LIMITS.maxSnapshotFiles
    });
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of snapshot.files) {
    const parsedPath = StudioPathSchema.safeParse(file.file);
    if (
      !parsedPath.success ||
      !(file.content instanceof Uint8Array) ||
      !Number.isInteger(file.mode) ||
      (file.mode !== 0o644 && file.mode !== 0o755) ||
      !StudioDigestSchema.safeParse(file.sha256).success
    ) {
      throw invalidSnapshot(
        resource.data,
        "Historical storage returned invalid file metadata"
      );
    }
    const key = studioPathKey(parsedPath.data);
    if (
      seen.has(key) ||
      !isStudioEditableResourcePath(resource.data, parsedPath.data) ||
      isStudioHistorySensitivePath(parsedPath.data.path) ||
      studioAuthoringContentDigest(file.content) !== file.sha256
    ) {
      throw invalidSnapshot(
        resource.data,
        "Historical storage returned an invalid entity file"
      );
    }
    if (
      file.content.byteLength >
      STUDIO_RESOURCE_HISTORY_LIMITS.maxSnapshotFileBytes
    ) {
      throw oversizedSnapshot(resource.data, {
        actualBytes: file.content.byteLength,
        maxBytes: STUDIO_RESOURCE_HISTORY_LIMITS.maxSnapshotFileBytes
      });
    }
    try {
      UTF8_DECODER.decode(file.content);
    } catch (cause) {
      throw new StudioResourceHistoryError(
        "studio_history_resource_invalid",
        "Historical storage returned a non-text entity file",
        { cause, details: { resource: resource.data } }
      );
    }
    seen.add(key);
    totalBytes += file.content.byteLength;
    if (totalBytes > STUDIO_RESOURCE_HISTORY_LIMITS.maxSnapshotBytes) {
      throw oversizedSnapshot(resource.data, {
        actualBytes: totalBytes,
        maxBytes: STUDIO_RESOURCE_HISTORY_LIMITS.maxSnapshotBytes
      });
    }
  }
  if (
    !seen.has(studioPathKey(studioEditableDefinitionFile(resource.data)))
  ) {
    throw invalidSnapshot(
      resource.data,
      "Historical storage returned a snapshot without its entity definition"
    );
  }
}
