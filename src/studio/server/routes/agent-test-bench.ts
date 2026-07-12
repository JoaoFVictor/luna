import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  StudioAgentTestExecuteRequestSchema,
  StudioAgentTestPlanIdSchema,
  StudioAgentTestPlanRequestSchema,
  StudioAgentTestPlanSchema,
  StudioAgentTestResultSchema,
  type StudioAgentTestExecuteRequest,
  type StudioAgentTestLaunchContext,
  type StudioAgentTestPlan,
  type StudioAgentTestPlanRequest,
  type StudioAgentTestResult
} from "../../contracts/agent-test-bench.js";
import { withStudioRequestAbort } from "../request-abort.js";

const StudioAgentTestPlanParamsSchema = z
  .object({ planId: StudioAgentTestPlanIdSchema })
  .strict();

export type StudioAgentTestBenchControl = {
  readonly plan: (
    input: StudioAgentTestPlanRequest,
    context: StudioAgentTestLaunchContext,
    signal?: AbortSignal
  ) => Promise<StudioAgentTestPlan>;
  readonly execute: (
    planId: string,
    input: StudioAgentTestExecuteRequest,
    context: StudioAgentTestLaunchContext,
    signal?: AbortSignal
  ) => Promise<StudioAgentTestResult>;
};

export type StudioAgentTestBenchRouteOptions = {
  readonly apiPrefix: string;
  readonly control: StudioAgentTestBenchControl;
  readonly launchContextFor: (
    request: FastifyRequest
  ) => StudioAgentTestLaunchContext;
  readonly parseRequest: <Schema extends z.ZodTypeAny>(
    schema: Schema,
    value: unknown
  ) => z.output<Schema>;
};

export async function registerStudioAgentTestBenchRoutes(
  server: FastifyInstance,
  options: StudioAgentTestBenchRouteOptions
): Promise<void> {
  const base = `${options.apiPrefix}/agent-test-plans`;

  server.post(base, async (request, reply) => {
    const context = options.launchContextFor(request);
    const body = options.parseRequest(
      StudioAgentTestPlanRequestSchema,
      request.body
    );
    return await withStudioRequestAbort(request, reply, async (signal) =>
      StudioAgentTestPlanSchema.parse(
        await options.control.plan(body, context, signal)
      )
    );
  });

  server.post(`${base}/:planId/execute`, async (request, reply) => {
    const context = options.launchContextFor(request);
    const { planId } = options.parseRequest(
      StudioAgentTestPlanParamsSchema,
      request.params
    );
    const body = options.parseRequest(
      StudioAgentTestExecuteRequestSchema,
      request.body
    );
    return await withStudioRequestAbort(request, reply, async (signal) =>
      StudioAgentTestResultSchema.parse(
        await options.control.execute(planId, body, context, signal)
      )
    );
  });
}
