import type { AdapterPreview } from "@/api/types"
import { studioResponseContracts } from "@/api/response-contracts"
import type { StudioRequest } from "@/api/client-core"

export class StudioInputRoutingClient {
  readonly #request: StudioRequest

  constructor(request: StudioRequest) {
    this.#request = request
  }

  readonly inputAdapters = (signal?: AbortSignal) => {
    return this.#request(
      "/input-adapters",
      { signal },
      studioResponseContracts.inputAdapters,
    )
  }

  readonly previewInputAdapter = (
    adapterId: string,
    value: string,
    acknowledgedEffects: string[],
  ) => {
    return this.#request(
      `/input-adapters/${encodeURIComponent(adapterId)}/preview`,
      {
        method: "POST",
        body: {
          input: { kind: "cli", value },
          acknowledged_effects: acknowledgedEffects,
        },
      },
      studioResponseContracts.adapterPreview,
    )
  }

  readonly previewInputRoute = (
    adapterId: string,
    value: string,
    acknowledgedEffects: string[],
    signal?: AbortSignal,
  ) => {
    return this.#request(
      `/input-adapters/${encodeURIComponent(adapterId)}/route-preview`,
      {
        method: "POST",
        body: {
          input: { kind: "cli", value },
          acknowledged_effects: acknowledgedEffects,
        },
        ...(signal === undefined ? {} : { signal }),
      },
      studioResponseContracts.adapterRoutingPreview,
    )
  }

  readonly simulateRouting = (invocation: AdapterPreview["invocation"]) => {
    return this.#request(
      "/routing/simulate",
      {
        method: "POST",
        body: { invocation },
      },
      studioResponseContracts.routingSimulation,
    )
  }

  readonly routing = (signal?: AbortSignal) => {
    return this.#request(
      "/configuration/routing",
      { signal },
      studioResponseContracts.routing,
    )
  }
}
