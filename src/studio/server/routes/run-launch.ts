import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { StudioRunLaunchService } from "../../application/runs/launch-service.js";
import {
  StudioRunPlanInputSchema,
  type StudioRunPlanInput
} from "../../contracts/run-plan-input.js";
import {
  StudioRunDispatchReceiptSchema,
  StudioRunExecuteRequestSchema,
  StudioRunPlanIdSchema,
  StudioRunPlanSchema,
  type StudioRunLaunchContext
} from "../../contracts/run-launch.js";
import { withStudioRequestAbort } from "../request-abort.js";

const StudioRunPlanParamsSchema = z
  .object({ planId: StudioRunPlanIdSchema })
  .strict();

export type StudioRunLaunchControl = Pick<
  StudioRunLaunchService<unknown>,
  "execute"
> & {
  readonly plan: (
    input: StudioRunPlanInput,
    context: StudioRunLaunchContext,
    signal?: AbortSignal
  ) => ReturnType<StudioRunLaunchService<unknown>["plan"]>;
};

export type StudioRunLaunchRouteOptions = {
  readonly apiPrefix: string;
  readonly control: StudioRunLaunchControl;
  readonly launchContextFor: (
    request: FastifyRequest
  ) => StudioRunLaunchContext;
  readonly parseRequest: <Schema extends z.ZodTypeAny>(
    schema: Schema,
    value: unknown
  ) => z.output<Schema>;
};

export async function registerStudioRunLaunchRoutes(
  server: FastifyInstance,
  options: StudioRunLaunchRouteOptions
): Promise<void> {
  const base = `${options.apiPrefix}/run-plans`;

  server.post(base, async (request, reply) => {
    const context = options.launchContextFor(request);
    const body = options.parseRequest(StudioRunPlanInputSchema, request.body);
    return await withStudioRequestAbort(request, reply, async (signal) =>
      StudioRunPlanSchema.parse(
        await options.control.plan(body, context, signal)
      )
    );
  });

  server.post(`${base}/:planId/execute`, async (request, reply) => {
    const context = options.launchContextFor(request);
    const { planId } = options.parseRequest(
      StudioRunPlanParamsSchema,
      request.params
    );
    const body = options.parseRequest(
      StudioRunExecuteRequestSchema,
      request.body
    );
    return await withStudioRequestAbort(request, reply, async (signal) => {
      const receipt = StudioRunDispatchReceiptSchema.parse(
        await options.control.execute(planId, body, context, signal)
      );
      return await reply.code(202).send(receipt);
    });
  });
}
