import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { StudioRunInterruptService } from "../../application/runs/interrupt-service.js";
import {
  StudioRunInterruptListSchema,
  StudioRunInterruptListQuerySchema,
  StudioRunInterruptResumeReceiptSchema,
  StudioRunInterruptResumeRequestSchema
} from "../../contracts/run-interrupts.js";
import { StudioRunParamsSchema } from "../../contracts/run-api.js";
import type { StudioLocalPrincipal } from "../../contracts/control-api.js";

const StudioRunInterruptParamsSchema = StudioRunParamsSchema.extend({
  interruptId: z.string().trim().min(1).max(256)
}).strict();

const StudioRunInterruptHttpQuerySchema = z.object({
  cursor: z.string().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().safe().min(1).max(200).optional()
}).strict();

export type StudioRunInterruptControl = Pick<
  StudioRunInterruptService,
  "list" | "resume"
>;

export async function registerStudioRunInterruptRoutes(
  server: FastifyInstance,
  options: {
    readonly apiPrefix: string;
    readonly control: StudioRunInterruptControl;
    readonly principalFor: (request: FastifyRequest) => StudioLocalPrincipal;
    readonly parseRequest: <T>(schema: z.ZodType<T>, value: unknown) => T;
  }
): Promise<void> {
  const base = `${options.apiPrefix}/runs/:runId/interrupts`;

  server.get(base, async (request) => {
    options.principalFor(request);
    const { runId } = options.parseRequest(StudioRunParamsSchema, request.params);
    const httpQuery = options.parseRequest(StudioRunInterruptHttpQuerySchema, request.query);
    const query = options.parseRequest(StudioRunInterruptListQuerySchema, httpQuery);
    return StudioRunInterruptListSchema.parse(
      await options.control.list(runId, query)
    );
  });

  server.post(`${base}/:interruptId/resume`, async (request, reply) => {
    options.principalFor(request);
    const { runId, interruptId } = options.parseRequest(
      StudioRunInterruptParamsSchema,
      request.params
    );
    const body = options.parseRequest(
      StudioRunInterruptResumeRequestSchema,
      request.body
    );
    const receipt = StudioRunInterruptResumeReceiptSchema.parse(
      await options.control.resume(runId, interruptId, body)
    );
    return await reply.code(202).send(receipt);
  });
}
