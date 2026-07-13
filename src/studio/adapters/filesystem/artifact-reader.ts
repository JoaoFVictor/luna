import { createHash } from "node:crypto";
import type { JsonValue } from "../../../core/json/value.js";
import type {
  ArtifactManifest,
  ArtifactManifestStore
} from "../../../core/runtime/artifacts/contracts.js";
import {
  ARTIFACT_MANIFEST_LIST_LIMIT_MAXIMA,
  ArtifactManifestListLimitError
} from "../../../core/runtime/artifacts/contracts.js";
import {
  redactValue
} from "../../../core/security/redactor.js";
import {
  ArtifactManifestHandleSchema,
  ArtifactPreviewRequestSchema,
  type ArtifactList,
  type ArtifactManifestHandle,
  type ArtifactMetadata,
  type ArtifactPreview,
  type ArtifactSummary
} from "../../contracts/artifacts.js";
import { RunOpaqueIdSchema } from "../../contracts/runs.js";
import {
  ArtifactReaderError,
  artifactReaderError
} from "../../application/artifacts/errors.js";
import type {
  ArtifactDownload,
  ArtifactReaderPort
} from "../../application/artifacts/ports.js";
import { createArtifactHandleCodec } from "./artifact-handles.js";
import {
  projectArtifactSummary,
  validateArtifactManifest
} from "./artifact-manifest-projection.js";
import {
  isActiveArtifactContent,
  isJsonArtifactMediaType,
  isPlausiblyBinaryArtifact,
  isReadableArtifactStatus,
  validatedArtifactJsonValue
} from "./artifact-presentation.js";
import { redactStudioText } from "../redaction/text.js";
import {
  openSecureRegularFile,
  type SecureReadonlyFile
} from "./secure-read-file.js";
import {
  artifactMetadataFor,
  artifactPreviewIntegrity,
  mapUnexpectedArtifactReadError,
  positiveArtifactReaderLimit,
  readArtifactPreviewBytes
} from "./artifact-read-support.js";

const DEFAULT_MAX_PREVIEW_BYTES = 256 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const DEFAULT_DOWNLOAD_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_JSON_DEPTH = 64;
const DEFAULT_MAX_JSON_NODES = 50_000;
const DEFAULT_MAX_ARTIFACTS_PER_RUN = 10_000;
const DEFAULT_MAX_MANIFEST_BYTES = 256 * 1024;
const DEFAULT_MAX_MANIFEST_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_MANIFEST_SCANNED_ENTRIES = 20_000;
const FILESYSTEM_ARTIFACT_BACKEND = "filesystem.artifacts";

export type FilesystemArtifactReaderOptions = {
  readonly root: string;
  readonly manifests: ArtifactManifestStore;
  readonly handleKey?: Uint8Array;
  readonly backendId?: string;
  readonly maxPreviewBytes?: number;
  readonly maxArtifactBytes?: number;
  readonly downloadChunkBytes?: number;
  readonly maxJsonDepth?: number;
  readonly maxJsonNodes?: number;
  readonly maxArtifactsPerRun?: number;
  readonly maxManifestBytes?: number;
  readonly maxManifestTotalBytes?: number;
  readonly maxManifestScannedEntries?: number;
};

type ResolvedArtifact = {
  readonly manifest: ArtifactManifest;
  readonly summary: ArtifactSummary;
};

type OpenedArtifact = ResolvedArtifact & {
  readonly file: SecureReadonlyFile;
  readonly metadata: ArtifactMetadata;
};

function safeRunId(value: string): string {
  const result = RunOpaqueIdSchema.safeParse(value);
  if (!result.success) {
    throw artifactReaderError("artifact_input_invalid", "Run identifier is invalid");
  }
  return result.data;
}

function safeHandle(value: string): ArtifactManifestHandle {
  const result = ArtifactManifestHandleSchema.safeParse(value);
  if (!result.success) {
    throw artifactReaderError("artifact_handle_invalid", "Artifact handle is invalid");
  }
  return result.data;
}

export function createFilesystemArtifactReader(
  options: FilesystemArtifactReaderOptions
): ArtifactReaderPort {
  const maxPreviewBytes = positiveArtifactReaderLimit(
    options.maxPreviewBytes ?? DEFAULT_MAX_PREVIEW_BYTES,
    "maxPreviewBytes"
  );
  const maxArtifactBytes = positiveArtifactReaderLimit(
    options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
    "maxArtifactBytes"
  );
  const downloadChunkBytes = positiveArtifactReaderLimit(
    options.downloadChunkBytes ?? DEFAULT_DOWNLOAD_CHUNK_BYTES,
    "downloadChunkBytes",
    1024 * 1024
  );
  const maxJsonDepth = positiveArtifactReaderLimit(
    options.maxJsonDepth ?? DEFAULT_MAX_JSON_DEPTH,
    "maxJsonDepth",
    1_024
  );
  const maxJsonNodes = positiveArtifactReaderLimit(
    options.maxJsonNodes ?? DEFAULT_MAX_JSON_NODES,
    "maxJsonNodes",
    1_000_000
  );
  const maxArtifactsPerRun = positiveArtifactReaderLimit(
    options.maxArtifactsPerRun ?? DEFAULT_MAX_ARTIFACTS_PER_RUN,
    "maxArtifactsPerRun",
    10_000
  );
  const maxManifestBytes = positiveArtifactReaderLimit(
    options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES,
    "maxManifestBytes",
    ARTIFACT_MANIFEST_LIST_LIMIT_MAXIMA.max_entry_bytes
  );
  const maxManifestTotalBytes = positiveArtifactReaderLimit(
    options.maxManifestTotalBytes ?? DEFAULT_MAX_MANIFEST_TOTAL_BYTES,
    "maxManifestTotalBytes",
    ARTIFACT_MANIFEST_LIST_LIMIT_MAXIMA.max_total_bytes
  );
  const maxManifestScannedEntries = positiveArtifactReaderLimit(
    options.maxManifestScannedEntries ?? DEFAULT_MAX_MANIFEST_SCANNED_ENTRIES,
    "maxManifestScannedEntries",
    ARTIFACT_MANIFEST_LIST_LIMIT_MAXIMA.max_scanned_entries
  );
  if (maxManifestBytes > maxManifestTotalBytes) {
    throw new Error("maxManifestBytes cannot exceed maxManifestTotalBytes");
  }
  if (maxArtifactsPerRun > maxManifestScannedEntries) {
    throw new Error("maxArtifactsPerRun cannot exceed maxManifestScannedEntries");
  }
  const backendId = options.backendId ?? FILESYSTEM_ARTIFACT_BACKEND;
  if (backendId.length < 1 || backendId.length > 256) {
    throw new Error("backendId must contain between 1 and 256 characters");
  }
  const handles = createArtifactHandleCodec(options.handleKey);

  async function manifestsForRun(runId: string): Promise<readonly ArtifactManifest[]> {
    try {
      const manifests = await options.manifests.list(runId, {
        max_entries: maxArtifactsPerRun,
        max_entry_bytes: maxManifestBytes,
        max_total_bytes: maxManifestTotalBytes,
        max_scanned_entries: maxManifestScannedEntries
      });
      if (manifests.length > maxArtifactsPerRun) {
        throw artifactReaderError(
          "artifact_too_large",
          "Run exposes too many artifact manifests",
          { max_artifacts: maxArtifactsPerRun }
        );
      }
      const seen = new Set<string>();
      for (const manifest of manifests) {
        validateArtifactManifest(manifest, runId, backendId);
        const handle = handles.encode(manifest);
        if (seen.has(handle)) {
          throw artifactReaderError(
            "artifact_catalog_corrupt",
            "Artifact handles are ambiguous"
          );
        }
        seen.add(handle);
      }
      return manifests;
    } catch (cause) {
      if (cause instanceof ArtifactReaderError) {
        throw cause;
      }
      if (cause instanceof ArtifactManifestListLimitError) {
        const detail: Record<string, number> = {};
        const detailKey = cause.kind === "entries"
          ? "max_artifacts"
          : cause.kind === "entry_bytes"
            ? "max_manifest_bytes"
            : cause.kind === "total_bytes"
              ? "max_manifest_total_bytes"
              : "max_manifest_scanned_entries";
        detail[detailKey] = cause.maximum;
        throw artifactReaderError(
          "artifact_too_large",
          "Artifact manifest catalog exceeds its configured limit",
          detail
        );
      }
      throw artifactReaderError(
        "artifact_catalog_corrupt",
        "Artifact metadata could not be loaded"
      );
    }
  }

  async function resolveArtifact(
    rawRunId: string,
    rawHandle: string
  ): Promise<ResolvedArtifact> {
    const runId = safeRunId(rawRunId);
    const handle = safeHandle(rawHandle);
    const manifests = await manifestsForRun(runId);
    const manifest = manifests.find((candidate) => handles.matches(handle, candidate));
    if (manifest === undefined) {
      throw artifactReaderError("artifact_not_found", "Artifact was not found");
    }
    const summary = projectArtifactSummary(manifest, runId, backendId, handles);
    if (!isReadableArtifactStatus(summary.status)) {
      throw artifactReaderError(
        "artifact_unavailable",
        "Artifact content is not committed"
      );
    }
    return { manifest, summary };
  }

  async function openArtifact(resolved: ResolvedArtifact): Promise<OpenedArtifact> {
    const artifactPath = validateArtifactManifest(
      resolved.manifest,
      resolved.manifest.run_id,
      backendId
    );
    try {
      const file = await openSecureRegularFile(options.root, [
        resolved.manifest.run_id,
        ...artifactPath.split("/")
      ]);
      if (file.size > maxArtifactBytes) {
        await file.handle.close().catch(() => undefined);
        throw artifactReaderError(
          "artifact_too_large",
          "Artifact exceeds the configured size limit",
          { max_bytes: maxArtifactBytes }
        );
      }
      return {
        ...resolved,
        file,
        metadata: artifactMetadataFor(resolved.summary, file.size)
      };
    } catch (cause) {
      throw mapUnexpectedArtifactReadError(cause);
    }
  }

  async function* streamOriginal(
    resolved: ResolvedArtifact,
    expected: ArtifactMetadata
  ): AsyncGenerator<Uint8Array> {
    let opened: OpenedArtifact | undefined;
    try {
      opened = await openArtifact(resolved);
      if (opened.file.size !== expected.content_length) {
        throw artifactReaderError(
          "artifact_content_changed",
          "Artifact content changed before download"
        );
      }

      const expectedHash = opened.manifest.content_hash;
      const hash = expectedHash === undefined ? undefined : createHash("sha256");
      let position = 0;
      while (position < opened.file.size) {
        const length = Math.min(downloadChunkBytes, opened.file.size - position);
        const buffer = Buffer.allocUnsafe(length);
        const read = await opened.file.handle.read(buffer, 0, length, position);
        if (read.bytesRead === 0) {
          throw artifactReaderError(
            "artifact_content_changed",
            "Artifact content changed during download"
          );
        }
        const chunk = buffer.subarray(0, read.bytesRead);
        position += read.bytesRead;
        hash?.update(chunk);
        yield Buffer.from(chunk);
      }

      const finalStat = await opened.file.handle.stat({ bigint: true });
      if (
        finalStat.size !== BigInt(opened.file.size) ||
        finalStat.mtimeNs.toString(10) !== opened.file.modified_nanoseconds
      ) {
        throw artifactReaderError(
          "artifact_content_changed",
          "Artifact content changed during download"
        );
      }
      if (
        expectedHash !== undefined &&
        `sha256:${hash?.digest("hex")}` !== expectedHash
      ) {
        throw artifactReaderError(
          "artifact_content_changed",
          "Artifact content does not match its manifest"
        );
      }
    } catch (cause) {
      throw mapUnexpectedArtifactReadError(cause);
    } finally {
      await opened?.file.handle.close().catch(() => undefined);
    }
  }

  return {
    async list(rawRunId): Promise<ArtifactList> {
      const runId = safeRunId(rawRunId);
      const manifests = await manifestsForRun(runId);
      const items = manifests.map((manifest) =>
        projectArtifactSummary(manifest, runId, backendId, handles));
      items.sort((left, right) =>
        left.created_at.localeCompare(right.created_at) ||
        (left.source_node_id ?? "").localeCompare(right.source_node_id ?? "") ||
        left.attempt - right.attempt ||
        left.manifest_handle.localeCompare(right.manifest_handle));
      return { run_id: runId, items, redaction: "best_effort_on_preview" };
    },

    async resolveReferences(rawRunId, references) {
      const runId = safeRunId(rawRunId);
      if (references.length === 0) {
        return { matches: [] };
      }
      const manifests = await manifestsForRun(runId);
      const matches = references.map((reference) => {
        const candidates = manifests.filter((candidate) =>
          candidate.id === reference.id &&
          candidate.uri === reference.uri &&
          candidate.source_node_id === reference.node_id
        );
        if (candidates.length > 1) {
          throw artifactReaderError(
            "artifact_catalog_corrupt",
            "Artifact reference resolves to multiple manifests"
          );
        }
        const manifest = candidates[0];
        return manifest === undefined
          ? { status: "unresolved" as const }
          : {
              status: "resolved" as const,
              artifact: projectArtifactSummary(manifest, runId, backendId, handles)
            };
      });
      return { matches };
    },

    async metadata(rawRunId, rawHandle): Promise<ArtifactMetadata> {
      const resolved = await resolveArtifact(rawRunId, rawHandle);
      const opened = await openArtifact(resolved);
      try {
        return opened.metadata;
      } finally {
        await opened.file.handle.close().catch(() => undefined);
      }
    },

    async preview(rawRequest): Promise<ArtifactPreview> {
      const requestResult = ArtifactPreviewRequestSchema.safeParse(rawRequest);
      if (!requestResult.success) {
        throw artifactReaderError("artifact_input_invalid", "Artifact preview request is invalid");
      }
      const request = requestResult.data;
      const maximum = request.max_bytes ?? maxPreviewBytes;
      if (maximum > maxPreviewBytes) {
        throw artifactReaderError(
          "artifact_input_invalid",
          "Artifact preview limit exceeds the server maximum",
          { max_bytes: maxPreviewBytes }
        );
      }
      const resolved = await resolveArtifact(request.run_id, request.manifest_handle);
      const opened = await openArtifact(resolved);
      try {
        if (isActiveArtifactContent(opened.metadata.media_type)) {
          return {
            kind: "download_only",
            metadata: opened.metadata,
            inspected_bytes: 0,
            truncated: false,
            integrity: opened.manifest.content_hash === undefined
              ? "not_declared"
              : "not_checked",
            reason: "active_content",
            render_policy: "download_only"
          };
        }

        const content = await readArtifactPreviewBytes(opened.file, maximum);
        const truncated = opened.file.size > content.length;
        const integrity = artifactPreviewIntegrity(
          opened.manifest,
          content,
          truncated
        );
        if (isPlausiblyBinaryArtifact(content)) {
          return {
            kind: "binary",
            metadata: opened.metadata,
            inspected_bytes: content.length,
            truncated,
            integrity,
            reason: "binary_content",
            render_policy: "download_only"
          };
        }

        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(content, {
            stream: truncated
          });
        } catch {
          return {
            kind: "binary",
            metadata: opened.metadata,
            inspected_bytes: content.length,
            truncated,
            integrity,
            reason: "binary_content",
            render_policy: "download_only"
          };
        }

        if (isJsonArtifactMediaType(opened.metadata.media_type) && !truncated) {
          try {
            const parsed = validatedArtifactJsonValue(
              JSON.parse(text) as unknown,
              maxJsonDepth,
              maxJsonNodes
            );
            if (parsed.kind === "valid") {
              const redacted = redactValue(parsed.value) as JsonValue;
              return {
                kind: "json",
                metadata: opened.metadata,
                inspected_bytes: content.length,
                truncated: false,
                integrity,
                encoding: "utf-8",
                value: redacted,
                redaction: {
                  mode: "best_effort",
                  changed: JSON.stringify(redacted) !== JSON.stringify(parsed.value)
                },
                render_policy: "structured_data_only"
              };
            }
            const redactedText = redactStudioText(text);
            return {
              kind: "text",
              metadata: opened.metadata,
              inspected_bytes: content.length,
              truncated: false,
              integrity,
              encoding: "utf-8",
              text: redactedText,
              redaction: {
                mode: "best_effort",
                changed: redactedText !== text
              },
              diagnostic: "json_complexity_limit",
              render_policy: "plain_text_only"
            };
          } catch (cause) {
            if (cause instanceof ArtifactReaderError) {
              throw cause;
            }
            const redactedText = redactStudioText(text);
            return {
              kind: "text",
              metadata: opened.metadata,
              inspected_bytes: content.length,
              truncated: false,
              integrity,
              encoding: "utf-8",
              text: redactedText,
              redaction: {
                mode: "best_effort",
                changed: redactedText !== text
              },
              diagnostic: "invalid_json",
              render_policy: "plain_text_only"
            };
          }
        }

        const redactedText = redactStudioText(text);
        return {
          kind: "text",
          metadata: opened.metadata,
          inspected_bytes: content.length,
          truncated,
          integrity,
          encoding: "utf-8",
          text: redactedText,
          redaction: {
            mode: "best_effort",
            changed: redactedText !== text
          },
          render_policy: "plain_text_only"
        };
      } catch (cause) {
        throw mapUnexpectedArtifactReadError(cause);
      } finally {
        await opened.file.handle.close().catch(() => undefined);
      }
    },

    async openDownload(rawRunId, rawHandle): Promise<ArtifactDownload> {
      const resolved = await resolveArtifact(rawRunId, rawHandle);
      const opened = await openArtifact(resolved);
      const metadata = opened.metadata;
      await opened.file.handle.close().catch(() => undefined);
      return {
        metadata,
        body: streamOriginal(resolved, metadata),
        disposition: "attachment",
        redaction: "not_applied"
      };
    }
  };
}
