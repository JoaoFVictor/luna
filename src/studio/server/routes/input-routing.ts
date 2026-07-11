import type {
  FastifyInstance,
  FastifyRequest
} from "fastify";
import { z } from "zod";
import { RouterDefinitionSchema, type RouterDefinition } from "../../../core/router/router-definition.js";
import {
  StudioAdapterPreviewRequestSchema,
  StudioAdapterPreviewSchema,
  StudioAdapterRoutingPreviewSchema,
  StudioInputAdapterCatalogSchema,
  StudioRoutingSimulationSchema,
  type StudioAdapterPreview,
  type StudioAdapterRoutingPreview,
  type StudioInputAdapterCatalog,
  type StudioRoutingSimulation
} from "../../contracts/input-routing.js";
import type { StudioLocalPrincipal } from "../../contracts/control-api.js";
import { withStudioRequestAbort } from "../request-abort.js";

const AdapterParamsSchema = z
  .object({ adapterId: z.string().min(1).max(128) })
  .strict();
const AdapterPreviewBodySchema = StudioAdapterPreviewRequestSchema.omit({
  adapter_id: true
});

export type StudioInputRoutingControl = {
  readonly listInputAdapters: (
    principal: StudioLocalPrincipal
  ) => Promise<StudioInputAdapterCatalog> | StudioInputAdapterCatalog;
  readonly previewInputAdapter: (
    principal: StudioLocalPrincipal,
    request: z.infer<typeof StudioAdapterPreviewRequestSchema>,
    signal: AbortSignal
  ) => Promise<StudioAdapterPreview>;
  readonly previewInputRoute: (
    principal: StudioLocalPrincipal,
    request: z.infer<typeof StudioAdapterPreviewRequestSchema>,
    signal: AbortSignal
  ) => Promise<StudioAdapterRoutingPreview>;
  readonly routingDefinition: (
    principal: StudioLocalPrincipal
  ) => Promise<RouterDefinition> | RouterDefinition;
  readonly simulateRouting: (
    principal: StudioLocalPrincipal,
    request: unknown,
    signal: AbortSignal
  ) => Promise<StudioRoutingSimulation>;
};

export type StudioInputRoutingRouteOptions = {
  readonly apiPrefix: string;
  readonly control: StudioInputRoutingControl;
  readonly principalFor: (request: FastifyRequest) => StudioLocalPrincipal;
  readonly parseRequest: <T>(schema: z.ZodType<T>, value: unknown) => T;
};

export async function registerStudioInputRoutingRoutes(
  server: FastifyInstance,
  options: StudioInputRoutingRouteOptions
): Promise<void> {
  const base = `${options.apiPrefix}/input-adapters`;

  server.get(base, async (request) =>
    StudioInputAdapterCatalogSchema.parse(
      await options.control.listInputAdapters(options.principalFor(request))
    )
  );

  server.post(`${base}/:adapterId/preview`, async (request, reply) => {
    const params = options.parseRequest(AdapterParamsSchema, request.params);
    const body = options.parseRequest(AdapterPreviewBodySchema, request.body);
    return await withStudioRequestAbort(request, reply, async (signal) =>
      StudioAdapterPreviewSchema.parse(
        await options.control.previewInputAdapter(
          options.principalFor(request),
          {
            adapter_id: params.adapterId,
            ...body
          },
          signal
        )
      )
    );
  });

  server.post(`${base}/:adapterId/route-preview`, async (request, reply) => {
    const params = options.parseRequest(AdapterParamsSchema, request.params);
    const body = options.parseRequest(AdapterPreviewBodySchema, request.body);
    return await withStudioRequestAbort(request, reply, async (signal) =>
      StudioAdapterRoutingPreviewSchema.parse(
        await options.control.previewInputRoute(
          options.principalFor(request),
          {
            adapter_id: params.adapterId,
            ...body
          },
          signal
        )
      )
    );
  });

  server.get(`${options.apiPrefix}/configuration/routing`, async (request) =>
    RouterDefinitionSchema.parse(
      await options.control.routingDefinition(options.principalFor(request))
    )
  );

  server.post(`${options.apiPrefix}/routing/simulate`, async (request, reply) =>
    await withStudioRequestAbort(request, reply, async (signal) =>
      StudioRoutingSimulationSchema.parse(
        await options.control.simulateRouting(
          options.principalFor(request),
          request.body,
          signal
        )
      )
    )
  );
}
