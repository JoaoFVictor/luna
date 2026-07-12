import type {
  GitRevisionId,
  HistoryResource,
} from "@/api/types"
import { studioResponseContracts } from "@/api/response-contracts"
import type { StudioRequest } from "@/api/client-core"

export class StudioHistoryClient {
  readonly #request: StudioRequest

  constructor(request: StudioRequest) {
    this.#request = request
  }

  readonly resourceHistory = (
    resource: HistoryResource,
    limit = 25,
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({ limit: String(limit) })
    return this.#request(
      `${this.resourceHistoryPath(resource)}?${query.toString()}`,
      { signal },
      studioResponseContracts.resourceHistory,
    )
  }

  readonly compareResourceHistory = (
    resource: HistoryResource,
    baseRevisionId: GitRevisionId,
    targetRevisionId: GitRevisionId,
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({
      base_revision_id: baseRevisionId,
      target_revision_id: targetRevisionId,
    })
    return this.#request(
      `${this.resourceHistoryPath(resource)}/compare?${query.toString()}`,
      { signal },
      studioResponseContracts.resourceHistoryCompare,
    )
  }

  readonly restoreResourceHistory = (
    resource: HistoryResource,
    revisionId: GitRevisionId,
  ) => {
    return this.#request(
      `${this.resourceHistoryPath(resource)}/restore`,
      {
        method: "POST",
        body: {
          revision_id: revisionId,
          confirm_restore_as_new_draft: true,
        },
      },
      studioResponseContracts.resourceHistoryRestore,
    )
  }

  private resourceHistoryPath(resource: HistoryResource): string {
    return `/resources/${encodeURIComponent(resource.kind)}/${encodeURIComponent(resource.id)}/history`
  }
}
