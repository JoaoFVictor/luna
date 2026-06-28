import { z } from "zod";
import { MAX_WORKFLOW_REPAIR_ATTEMPTS } from "../../core/workflow/repair-attempts.js";
import { ChangeRequestConfigSchema } from "../change-request/contracts.js";
import { ValidationCommandSchema } from "../validation/command-runner.js";

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

export const ImplementationConfigSchema = z
  .object({
    implementation: z
      .object({
        branch_pattern: NonEmptyStringSchema,
        commit: z
          .object({
            enabled: z.boolean()
          })
          .strict(),
        push: z
          .object({
            enabled: z.boolean(),
            remote: NonEmptyStringSchema
          })
          .strict(),
        change_request: ChangeRequestConfigSchema,
        sandbox: z
          .object({
            type: z.literal("trusted_host_local"),
            env_allowlist: z.array(NonEmptyStringSchema)
          })
          .strict(),
        validation: z
          .object({
            repair_attempts: z
              .number()
              .int()
              .nonnegative()
              .max(MAX_WORKFLOW_REPAIR_ATTEMPTS),
            max_output_bytes: z.number().int().positive(),
            commands: z.array(ValidationCommandSchema)
          })
          .strict()
      })
      .strict()
  })
  .strict()
  .superRefine((config, context) => {
    if (config.implementation.push.enabled && !config.implementation.commit.enabled) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "push.enabled requires commit.enabled",
        path: ["implementation", "push", "enabled"]
      });
    }

    if (
      config.implementation.change_request.enabled &&
      !config.implementation.push.enabled
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "change_request.enabled requires push.enabled",
        path: ["implementation", "change_request", "enabled"]
      });
    }
  });
export type ImplementationConfig = z.infer<typeof ImplementationConfigSchema>;
