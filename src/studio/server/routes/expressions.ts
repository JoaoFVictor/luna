import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import {
  StudioExpressionEvaluationRequestSchema,
  StudioExpressionEvaluationSchema,
  type StudioExpressionEvaluation,
  type StudioExpressionEvaluationRequest
} from "../../contracts/expression-evaluation.js";
import type { StudioLocalPrincipal } from "../../contracts/control-api.js";
import { withStudioRequestAbort } from "../request-abort.js";

export type StudioExpressionControl = {
  readonly evaluateExpression: (
    principal: StudioLocalPrincipal,
    request: StudioExpressionEvaluationRequest,
    signal: AbortSignal
  ) => Promise<StudioExpressionEvaluation>;
};

export type StudioExpressionRouteOptions = {
  readonly apiPrefix: string;
  readonly control: StudioExpressionControl;
  readonly principalFor: (request: FastifyRequest) => StudioLocalPrincipal;
  readonly parseRequest: <T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    value: unknown
  ) => T;
};

export async function registerStudioExpressionRoutes(
  server: FastifyInstance,
  options: StudioExpressionRouteOptions
): Promise<void> {
  server.post(
    `${options.apiPrefix}/expressions/evaluate`,
    async (request, reply) => {
      const body = options.parseRequest(
        StudioExpressionEvaluationRequestSchema,
        request.body
      );
      return await withStudioRequestAbort(request, reply, async (signal) =>
        StudioExpressionEvaluationSchema.parse(
          await options.control.evaluateExpression(
            options.principalFor(request),
            body,
            signal
          )
        )
      );
    }
  );
}
