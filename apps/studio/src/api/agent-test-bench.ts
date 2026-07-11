import {
  StudioAgentTestExecuteRequestSchema,
  StudioAgentTestPlanIdSchema,
  StudioAgentTestPlanRequestSchema,
  StudioAgentTestPlanSchema,
  StudioAgentTestResultSchema,
  type StudioAgentTestExecuteRequest,
  type StudioAgentTestPlanRequest,
} from "../../../../src/studio/contracts/agent-test-bench.js"

import { StudioApiClient, studioApi } from "@/api/client"

export class StudioAgentTestBenchApi {
  readonly #client: StudioApiClient

  constructor(client: StudioApiClient = studioApi) {
    this.#client = client
  }

  plan(input: StudioAgentTestPlanRequest, signal?: AbortSignal) {
    const body = StudioAgentTestPlanRequestSchema.parse(input)
    return this.#client.request(
      "/agent-test-plans",
      {
        method: "POST",
        body,
        ...(signal === undefined ? {} : { signal }),
      },
      StudioAgentTestPlanSchema,
    )
  }

  execute(
    planId: string,
    input: StudioAgentTestExecuteRequest,
    signal?: AbortSignal,
  ) {
    const parsedPlanId = StudioAgentTestPlanIdSchema.parse(planId)
    const body = StudioAgentTestExecuteRequestSchema.parse(input)
    return this.#client.request(
      `/agent-test-plans/${encodeURIComponent(parsedPlanId)}/execute`,
      {
        method: "POST",
        body,
        ...(signal === undefined ? {} : { signal }),
      },
      StudioAgentTestResultSchema,
    )
  }
}

export const studioAgentTestBenchApi = new StudioAgentTestBenchApi()
