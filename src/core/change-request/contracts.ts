import { z } from "zod";
import type { PushBranchArtifact } from "../write-mode/types.js";

const NonEmptyStringSchema = z.string().min(1);

export const ChangeRequestArtifactSchema = z
  .object({
    enabled: z.boolean(),
    skipped: z.boolean(),
    reason: NonEmptyStringSchema.optional(),
    provider: NonEmptyStringSchema.optional(),
    url: NonEmptyStringSchema.optional()
  })
  .strict();
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

export type OpenChangeRequestRequest = {
  enabled: boolean;
  cwd: string;
  push: PushBranchArtifact;
  branch: string;
  baseRef?: string;
  draft: boolean;
  title: string;
  body?: string;
};

export type OpenChangeRequestResult = ChangeRequestArtifact;

export type ChangeRequestProvider = {
  provider: string;
  open(request: OpenChangeRequestRequest): Promise<OpenChangeRequestResult>;
};

export type ChangeRequestRegistry = {
  get(provider: string): ChangeRequestProvider;
};
