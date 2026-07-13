import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ArtifactListSchema,
  ArtifactManifestHandleSchema,
  ArtifactMetadataSchema,
  ArtifactPreviewSchema
} from "../../contracts/artifacts.js";
import { StudioRunParamsSchema } from "../../contracts/run-api.js";
import type { StudioLocalPrincipal } from "../../contracts/control-api.js";
import type { ArtifactReaderPort } from "../../application/artifacts/ports.js";
import type { RunCatalogPort } from "../../application/runs/ports.js";
import { runStoreError } from "../../application/runs/errors.js";

const ArtifactParamsSchema = StudioRunParamsSchema.extend({
  handle: ArtifactManifestHandleSchema
}).strict();

const ArtifactPreviewQuerySchema = z
  .object({
    max_bytes: z.coerce.number().int().safe().min(1).optional()
  })
  .strict();

export type StudioArtifactControl = {
  readonly reader: ArtifactReaderPort;
  readonly catalog: Pick<RunCatalogPort, "get">;
};

export type StudioArtifactRouteOptions = {
  readonly apiPrefix: string;
  readonly control: StudioArtifactControl;
  readonly principalFor: (request: FastifyRequest) => StudioLocalPrincipal;
  readonly parseRequest: <T>(schema: z.ZodType<T>, value: unknown) => T;
};

async function assertRunExists(
  catalog: Pick<RunCatalogPort, "get">,
  runId: string
): Promise<void> {
  if ((await catalog.get(runId)) === undefined) {
    throw runStoreError("run_not_found", "The requested run does not exist");
  }
}

function encodedFilename(name: string): string {
  return encodeURIComponent(name).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export async function registerStudioArtifactRoutes(
  server: FastifyInstance,
  options: StudioArtifactRouteOptions
): Promise<void> {
  const base = `${options.apiPrefix}/runs/:runId/artifacts`;

  server.get(base, async (request) => {
    options.principalFor(request);
    const { runId } = options.parseRequest(
      StudioRunParamsSchema,
      request.params
    );
    await assertRunExists(options.control.catalog, runId);
    return ArtifactListSchema.parse(await options.control.reader.list(runId));
  });

  server.get(`${base}/:handle`, async (request) => {
    options.principalFor(request);
    const { runId, handle } = options.parseRequest(
      ArtifactParamsSchema,
      request.params
    );
    await assertRunExists(options.control.catalog, runId);
    return ArtifactMetadataSchema.parse(
      await options.control.reader.metadata(runId, handle)
    );
  });

  server.get(`${base}/:handle/preview`, async (request) => {
    options.principalFor(request);
    const { runId, handle } = options.parseRequest(
      ArtifactParamsSchema,
      request.params
    );
    const query = options.parseRequest(
      ArtifactPreviewQuerySchema,
      request.query
    );
    await assertRunExists(options.control.catalog, runId);
    return ArtifactPreviewSchema.parse(
      await options.control.reader.preview({
        run_id: runId,
        manifest_handle: handle,
        ...(query.max_bytes === undefined
          ? {}
          : { max_bytes: query.max_bytes })
      })
    );
  });

  server.get(`${base}/:handle/download`, async (request, reply) => {
    options.principalFor(request);
    const { runId, handle } = options.parseRequest(
      ArtifactParamsSchema,
      request.params
    );
    await assertRunExists(options.control.catalog, runId);
    const download = await options.control.reader.openDownload(runId, handle);
    const filename = encodedFilename(download.metadata.name);
    reply
      .type(download.metadata.media_type)
      .header("Content-Length", download.metadata.content_length)
      .header(
        "Content-Disposition",
        `attachment; filename="artifact"; filename*=UTF-8''${filename}`
      );
    return reply.send(Readable.from(download.body));
  });
}
