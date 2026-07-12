import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);

export const StudioLocalPrincipalSchema = z
  .object({
    id: z.literal("local-user"),
    authentication: z.literal("local-session")
  })
  .strict();
export type StudioLocalPrincipal = z.infer<
  typeof StudioLocalPrincipalSchema
>;

export const StudioHealthResponseSchema = z
  .object({ status: z.literal("ok") })
  .strict();
export type StudioHealthResponse = z.infer<
  typeof StudioHealthResponseSchema
>;

export const StudioSessionExchangeRequestSchema = z
  .object({ capability: NonEmptyStringSchema })
  .strict();
export type StudioSessionExchangeRequest = z.infer<
  typeof StudioSessionExchangeRequestSchema
>;

export const StudioLocalSessionRequestSchema = z.object({}).strict();
export type StudioLocalSessionRequest = z.infer<
  typeof StudioLocalSessionRequestSchema
>;

export const StudioCsrfRotationRequestSchema = z.object({}).strict();
export type StudioCsrfRotationRequest = z.infer<
  typeof StudioCsrfRotationRequestSchema
>;

export const StudioSessionStateResponseSchema = z
  .object({
    csrf_token: NonEmptyStringSchema,
    expires_at: z.string().datetime(),
    principal: StudioLocalPrincipalSchema,
    mode: z.literal("local-single-user")
  })
  .strict();
export type StudioSessionStateResponse = z.infer<
  typeof StudioSessionStateResponseSchema
>;

export const StudioHttpErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: NonEmptyStringSchema,
        message: NonEmptyStringSchema,
        details: z.record(
          z.string().min(1).max(128),
          z.union([
            z.string().max(4_096),
            z.number().finite(),
            z.boolean(),
            z.null()
          ])
        ),
        request_id: NonEmptyStringSchema
      })
      .strict()
  })
  .strict();
export type StudioHttpErrorEnvelope = z.infer<
  typeof StudioHttpErrorEnvelopeSchema
>;
