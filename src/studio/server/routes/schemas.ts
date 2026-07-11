import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import {
  StudioSchemaValidationRequestSchema,
  StudioSchemaValidationSchema,
  type StudioSchemaValidation,
  type StudioSchemaValidationRequest
} from "../../contracts/schema-validation.js";
import type { StudioLocalPrincipal } from "../../contracts/control-api.js";
import { withStudioRequestAbort } from "../request-abort.js";

export type StudioSchemaControl = {
  readonly validateSchemaInstance: (
    principal: StudioLocalPrincipal,
    request: StudioSchemaValidationRequest,
    signal: AbortSignal
  ) => Promise<StudioSchemaValidation>;
};

export type StudioSchemaRouteOptions = {
  readonly apiPrefix: string;
  readonly control: StudioSchemaControl;
  readonly principalFor: (request: FastifyRequest) => StudioLocalPrincipal;
  readonly parseRequest: <T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    value: unknown
  ) => T;
};

export async function registerStudioSchemaRoutes(
  server: FastifyInstance,
  options: StudioSchemaRouteOptions
): Promise<void> {
  server.post(
    `${options.apiPrefix}/schemas/validate-instance`,
    async (request, reply) => {
      const body = options.parseRequest(
        StudioSchemaValidationRequestSchema,
        request.body
      );
      return await withStudioRequestAbort(request, reply, async (signal) =>
        StudioSchemaValidationSchema.parse(
          await options.control.validateSchemaInstance(
            options.principalFor(request),
            body,
            signal
          )
        )
      );
    }
  );
}
