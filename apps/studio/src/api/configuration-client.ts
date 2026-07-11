import type { ConfigurationPatchRequest } from "@/api/types"
import {
  studioResponseContracts,
  type StudioResponseContract,
} from "@/api/response-contracts"
import type { StudioRequest } from "@/api/client-core"

export class StudioConfigurationClient {
  readonly #request: StudioRequest

  constructor(request: StudioRequest) {
    this.#request = request
  }

  readonly workflowConfiguration = (
    workflowId: string,
    signal?: AbortSignal,
  ) => {
    return this.#request(
      `/configuration/workflows/${encodeURIComponent(workflowId)}`,
      { signal },
      studioResponseContracts.workflowConfiguration,
    )
  }

  readonly createConfigurationDraft = (workflowId: string) => {
    return this.#request(
      `/configuration/workflows/${encodeURIComponent(workflowId)}/drafts`,
      { method: "POST", body: {} },
      studioResponseContracts.configurationDraft,
    )
  }

  readonly configurationDraft = (
    workflowId: string,
    draftId: string,
    signal?: AbortSignal,
  ) => {
    return this.#request(
      `/configuration/workflows/${encodeURIComponent(workflowId)}/drafts/${encodeURIComponent(draftId)}`,
      { signal },
      studioResponseContracts.configurationDraft,
    )
  }

  readonly patchConfigurationDraft = (
    workflowId: string,
    draftId: string,
    etag: string,
    updates: ConfigurationPatchRequest["updates"],
  ) => {
    return this.#request(
      `/configuration/workflows/${encodeURIComponent(workflowId)}/drafts/${encodeURIComponent(draftId)}`,
      {
        method: "PATCH",
        headers: { "If-Match": etag },
        body: { updates },
      },
      studioResponseContracts.configurationDraft,
    )
  }

  readonly validateConfigurationDraft = (
    workflowId: string,
    draftId: string,
    etag: string,
  ) => {
    return this.configurationDraftCommand(
      workflowId,
      draftId,
      "validate",
      etag,
      studioResponseContracts.configurationValidation,
    )
  }

  readonly planConfigurationApply = (workflowId: string, draftId: string) => {
    return this.#request(
      `/configuration/workflows/${encodeURIComponent(workflowId)}/drafts/${encodeURIComponent(draftId)}/plan-apply`,
      { method: "POST", body: {} },
      studioResponseContracts.configurationApplyPlan,
    )
  }

  readonly applyConfigurationDraft = (
    workflowId: string,
    draftId: string,
    etag: string,
    planToken: string,
    idempotencyKey: string,
  ) => {
    return this.#request(
      `/configuration/workflows/${encodeURIComponent(workflowId)}/drafts/${encodeURIComponent(draftId)}/apply`,
      {
        method: "POST",
        headers: { "If-Match": etag },
        body: {
          plan_token: planToken,
          idempotency_key: idempotencyKey,
        },
      },
      studioResponseContracts.configurationApplyResult,
    )
  }

  readonly modelConfiguration = (signal?: AbortSignal) => {
    return this.#request(
      "/configuration/models",
      { signal },
      studioResponseContracts.modelConfiguration,
    )
  }

  readonly repositoryConfiguration = (signal?: AbortSignal) => {
    return this.#request(
      "/configuration/repositories",
      { signal },
      studioResponseContracts.repositoryConfiguration,
    )
  }

  readonly providerConfiguration = (signal?: AbortSignal) => {
    return this.#request(
      "/configuration/providers",
      { signal },
      studioResponseContracts.providerConfiguration,
    )
  }

  readonly runtimeConfiguration = (signal?: AbortSignal) => {
    return this.#request(
      "/configuration/runtime",
      { signal },
      studioResponseContracts.runtimeConfiguration,
    )
  }

  private configurationDraftCommand<T>(
    workflowId: string,
    draftId: string,
    command: string,
    etag: string,
    contract: StudioResponseContract<T>,
  ) {
    return this.#request(
      `/configuration/workflows/${encodeURIComponent(workflowId)}/drafts/${encodeURIComponent(draftId)}/${command}`,
      {
        method: "POST",
        headers: { "If-Match": etag },
        body: {},
      },
      contract,
    )
  }
}
