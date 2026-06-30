import { z } from "zod";
import type { ChangeRequestConfig } from "../change-request/contracts.js";
import type { ValidationCommand } from "../validation/command-runner.js";

const NonEmptyStringSchema = z.string().min(1);

export const GitGateArtifactSchema = z
  .object({
    enabled: z.boolean(),
    skipped: z.boolean(),
    reason: NonEmptyStringSchema.optional()
  })
  .strict();
export type GitGateArtifact = z.infer<typeof GitGateArtifactSchema>;

export const CommitChangesArtifactSchema = GitGateArtifactSchema.extend({
  commit_sha: NonEmptyStringSchema.optional(),
  branch: NonEmptyStringSchema.optional()
}).strict();
export type CommitChangesArtifact = z.infer<typeof CommitChangesArtifactSchema>;

export const PushBranchArtifactSchema = GitGateArtifactSchema.extend({
  remote: NonEmptyStringSchema.optional(),
  branch: NonEmptyStringSchema.optional()
}).strict();
export type PushBranchArtifact = z.infer<typeof PushBranchArtifactSchema>;

export const WorkspaceRecordSchema = z
  .object({
    run_id: NonEmptyStringSchema,
    path: NonEmptyStringSchema,
    preserved: z.boolean(),
    reason: NonEmptyStringSchema
  })
  .strict();
export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;

export type ImplementationConfig = {
  readonly implementation: {
    readonly branch_pattern: string;
    readonly commit: {
      readonly enabled: boolean;
    };
    readonly push: {
      readonly enabled: boolean;
      readonly remote: string;
    };
    readonly change_request: ChangeRequestConfig;
    readonly sandbox: {
      readonly type: "trusted_host_local";
      readonly env_allowlist: readonly string[];
    };
    readonly validation: {
      readonly repair_attempts: number;
      readonly max_output_bytes: number;
      readonly commands: readonly ValidationCommand[];
    };
  };
};
