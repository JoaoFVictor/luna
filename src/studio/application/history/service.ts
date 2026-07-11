import {
  StudioResourceHistoryCompareRequestSchema,
  StudioResourceHistoryCompareResponseSchema,
  StudioResourceHistoryListQuerySchema,
  StudioResourceHistoryResponseSchema,
  StudioResourceHistoryRestoreRequestSchema,
  StudioResourceHistoryRestoreResponseSchema,
  StudioHistoryResourceSchema,
  STUDIO_RESOURCE_HISTORY_LIMITS,
  type StudioHistoryResource,
  type StudioResourceHistoryCompareRequest,
  type StudioResourceHistoryCompareResponse,
  type StudioResourceHistoryListQuery,
  type StudioResourceHistoryResponse,
  type StudioResourceHistoryRestoreRequest,
  type StudioResourceHistoryRestoreResponse
} from "../../contracts/resource-history.js";
import { studioPathKey } from "../../contracts/paths.js";
import { projectStudioApplyDiff } from "../apply/diff.js";
import { StudioResourceHistoryError } from "./errors.js";
import { assertStudioHistoricalSnapshot } from "./snapshot-validation.js";
import type {
  StudioHistoricalDraftRestorePort,
  StudioHistoricalResourceFile,
  StudioHistoricalResourceSnapshot,
  StudioResourceHistoryPort
} from "./ports.js";

const MAX_COMPARE_DIFF_FILE_BYTES = 64 * 1024;
const MAX_COMPARE_DIFF_TOTAL_BYTES = 256 * 1024;

export type StudioResourceHistoryServiceOptions = {
  readonly history: StudioResourceHistoryPort;
  readonly restore: StudioHistoricalDraftRestorePort;
};

function fileMap(
  snapshot: StudioHistoricalResourceSnapshot
): ReadonlyMap<string, StudioHistoricalResourceFile> {
  return new Map(
    snapshot.files.map((file) => [studioPathKey(file.file), file])
  );
}

function comparisonKind(
  before: StudioHistoricalResourceFile | undefined,
  after: StudioHistoricalResourceFile | undefined
): "created" | "modified" | "deleted" {
  if (before === undefined) {
    return "created";
  }
  if (after === undefined) {
    return "deleted";
  }
  return "modified";
}

function filesDiffer(
  before: StudioHistoricalResourceFile | undefined,
  after: StudioHistoricalResourceFile | undefined
): boolean {
  return (
    before?.sha256 !== after?.sha256 ||
    before?.mode !== after?.mode
  );
}

function compareSnapshots(
  before: StudioHistoricalResourceSnapshot,
  after: StudioHistoricalResourceSnapshot
) {
  const beforeFiles = fileMap(before);
  const afterFiles = fileMap(after);
  const keys = new Set([...beforeFiles.keys(), ...afterFiles.keys()]);
  if (keys.size > STUDIO_RESOURCE_HISTORY_LIMITS.maxComparedFiles) {
    throw new StudioResourceHistoryError(
      "studio_history_source_too_large",
      "Historical comparison contains too many entity files",
      {
        details: {
          resource: before.resource,
          actualFiles: keys.size,
          maxFiles: STUDIO_RESOURCE_HISTORY_LIMITS.maxComparedFiles
        }
      }
    );
  }
  let remainingDiffBytes = MAX_COMPARE_DIFF_TOTAL_BYTES;

  return [...keys]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((key) => {
      const beforeFile = beforeFiles.get(key);
      const afterFile = afterFiles.get(key);
      if (!filesDiffer(beforeFile, afterFile)) {
        return [];
      }
      const file = afterFile?.file ?? beforeFile?.file;
      if (file === undefined) {
        throw new StudioResourceHistoryError(
          "studio_history_resource_invalid",
          "Historical comparison contains an invalid file"
        );
      }
      const maxTextBytes = Math.min(
        remainingDiffBytes,
        MAX_COMPARE_DIFF_FILE_BYTES
      );
      const projected = projectStudioApplyDiff({
        file,
        kind: comparisonKind(beforeFile, afterFile),
        before: beforeFile?.content,
        after: afterFile?.content,
        beforeSha256: beforeFile?.sha256 ?? null,
        afterSha256: afterFile?.sha256 ?? null,
        beforeMode: beforeFile?.mode ?? null,
        afterMode: afterFile?.mode ?? null,
        maxTextBytes
      });
      remainingDiffBytes -= Buffer.byteLength(projected.textual_diff, "utf8");
      return [projected];
    });
}

export class StudioResourceHistoryService {
  private readonly history: StudioResourceHistoryPort;
  private readonly restorePort: StudioHistoricalDraftRestorePort;

  constructor(options: StudioResourceHistoryServiceOptions) {
    this.history = options.history;
    this.restorePort = options.restore;
  }

  async list(
    resourceInput: StudioHistoryResource,
    queryInput: StudioResourceHistoryListQuery
  ): Promise<StudioResourceHistoryResponse> {
    const resource = StudioHistoryResourceSchema.parse(resourceInput);
    const query = StudioResourceHistoryListQuerySchema.parse(queryInput);
    const page = await this.history.list(resource, { limit: query.limit });
    return StudioResourceHistoryResponseSchema.parse({
      resource,
      revisions: page.revisions,
      truncated: page.truncated
    });
  }

  async compare(
    resourceInput: StudioHistoryResource,
    requestInput: StudioResourceHistoryCompareRequest
  ): Promise<StudioResourceHistoryCompareResponse> {
    const resource = StudioHistoryResourceSchema.parse(resourceInput);
    const request = StudioResourceHistoryCompareRequestSchema.parse(
      requestInput
    );
    const [before, after] = await Promise.all([
      this.history.snapshot(resource, request.base_revision_id),
      this.history.snapshot(resource, request.target_revision_id)
    ]);
    assertStudioHistoricalSnapshot(before, {
      resource,
      revisionId: request.base_revision_id
    });
    assertStudioHistoricalSnapshot(after, {
      resource,
      revisionId: request.target_revision_id
    });
    return StudioResourceHistoryCompareResponseSchema.parse({
      resource,
      base_revision_id: request.base_revision_id,
      target_revision_id: request.target_revision_id,
      diff: compareSnapshots(before, after)
    });
  }

  async restore(
    resourceInput: StudioHistoryResource,
    requestInput: StudioResourceHistoryRestoreRequest
  ): Promise<StudioResourceHistoryRestoreResponse> {
    const resource = StudioHistoryResourceSchema.parse(resourceInput);
    const request = StudioResourceHistoryRestoreRequestSchema.parse(
      requestInput
    );
    const snapshot = await this.history.snapshot(
      resource,
      request.revision_id
    );
    assertStudioHistoricalSnapshot(snapshot, {
      resource,
      revisionId: request.revision_id
    });
    const draft = await this.restorePort.createFromHistory(snapshot);
    return StudioResourceHistoryRestoreResponseSchema.parse({
      resource,
      revision_id: request.revision_id,
      draft
    });
  }
}
