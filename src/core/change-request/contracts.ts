import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);

export const ChangeRequestCreatedArtifactSchema = z
  .object({
    operation_id: z.literal("change-request.create"),
    enabled: z.literal(true),
    skipped: z.literal(false),
    provider: NonEmptyStringSchema,
    provider_id: NonEmptyStringSchema,
    external_id: NonEmptyStringSchema,
    url: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    source_branch: NonEmptyStringSchema,
    target_branch: NonEmptyStringSchema,
    adopted: z.boolean()
  })
  .strict();

export const ChangeRequestSkippedArtifactSchema = z
  .object({
    operation_id: z.literal("change-request.create"),
    enabled: z.boolean(),
    skipped: z.literal(true),
    reason: NonEmptyStringSchema,
    adopted: z.literal(false)
  })
  .strict();

export const ChangeRequestArtifactSchema = z.union([
  ChangeRequestCreatedArtifactSchema,
  ChangeRequestSkippedArtifactSchema
]);
export type ChangeRequestArtifact = z.infer<typeof ChangeRequestArtifactSchema>;

export const ChangeRequestConfigSchema = z
  .object({
    enabled: z.boolean(),
    provider: NonEmptyStringSchema,
    draft: z.boolean(),
    base_ref: NonEmptyStringSchema
  })
  .strict();
export type ChangeRequestConfig = z.infer<typeof ChangeRequestConfigSchema>;

export type ChangeRequestCreateOperationId = "change-request.create";

export type ChangeRequestCreateInput = {
  readonly operation_id: ChangeRequestCreateOperationId;
  readonly enabled: boolean;
  readonly provider_id: string;
  readonly repository_path: string;
  readonly title: string;
  readonly source_branch: string;
  readonly source?: ChangeRequestSourceInput;
  readonly description?: string;
  readonly target_branch: string;
  readonly draft?: boolean;
};

export type ChangeRequestSourceInput = {
  readonly enabled?: boolean;
  readonly skipped?: boolean;
  readonly branch?: string;
  readonly reason?: string;
};

export type ChangeRequestState = {
  readonly operation_id: ChangeRequestCreateOperationId;
  readonly provider_id: string;
  readonly external_id: string;
  readonly url: string;
  readonly title: string;
  readonly source_branch: string;
  readonly target_branch: string;
};

export type ChangeRequestCreatedResult = ChangeRequestState & {
  readonly enabled: true;
  readonly skipped: false;
  readonly provider: string;
  readonly adopted: boolean;
};

export type ChangeRequestSkippedResult = {
  readonly operation_id: ChangeRequestCreateOperationId;
  readonly enabled: boolean;
  readonly skipped: true;
  readonly reason: string;
  readonly adopted: false;
};

export type ChangeRequestCreateResult =
  | ChangeRequestCreatedResult
  | ChangeRequestSkippedResult;

export type ChangeRequestProviderPort = {
  readonly provider_id: string;
  readChangeRequest(
    input: ChangeRequestCreateInput
  ): ChangeRequestState | undefined | Promise<ChangeRequestState | undefined>;
  createChangeRequest(
    input: ChangeRequestCreateInput
  ): ChangeRequestCreatedResult | Promise<ChangeRequestCreatedResult>;
};

export type ChangeRequestProviderFactory = {
  readonly provider_id: string;
  createProvider(): ChangeRequestProviderPort;
};

export type ChangeRequestProviderRegistry = {
  get(providerId: string): ChangeRequestProviderPort;
};

export type ChangeRequestBuiltInPorts = {
  readonly providers: ChangeRequestProviderRegistry;
};
