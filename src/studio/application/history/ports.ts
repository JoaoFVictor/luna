import type { StudioDraftItem } from "../../contracts/draft-authoring.js";
import type { StudioPath } from "../../contracts/paths.js";
import type {
  StudioGitRevisionId,
  StudioHistoryResource,
  StudioResourceHistoryRevision
} from "../../contracts/resource-history.js";

export type StudioHistoricalResourceFile = {
  readonly file: StudioPath;
  readonly content: Uint8Array;
  readonly sha256: string;
  readonly mode: number;
};

export type StudioHistoricalResourceSnapshot = {
  readonly resource: StudioHistoryResource;
  readonly revisionId: StudioGitRevisionId;
  readonly files: readonly StudioHistoricalResourceFile[];
};

export type StudioResourceHistoryPage = {
  readonly revisions: readonly StudioResourceHistoryRevision[];
  readonly truncated: boolean;
};

/** Read-only, entity-scoped revision storage. It is not an arbitrary Git port. */
export type StudioResourceHistoryPort = {
  list(
    resource: StudioHistoryResource,
    options: { readonly limit: number }
  ): Promise<StudioResourceHistoryPage>;
  snapshot(
    resource: StudioHistoryResource,
    revisionId: StudioGitRevisionId
  ): Promise<StudioHistoricalResourceSnapshot>;
};

/** Creates an ordinary draft; it never applies or writes active source. */
export type StudioHistoricalDraftRestorePort = {
  createFromHistory(
    snapshot: StudioHistoricalResourceSnapshot
  ): Promise<StudioDraftItem>;
};
