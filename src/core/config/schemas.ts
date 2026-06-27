import { z } from "zod";
import { assertJsonValue, type JsonValue } from "../json/value.js";
import { SkillPathSchema } from "../skills/schemas.js";

const NonEmptyStringSchema = z.string().min(1);

const JsonObjectSchema = z
  .record(z.unknown())
  .superRefine((value, context) => {
    try {
      assertJsonValue(value);
    } catch (cause) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: cause instanceof Error ? cause.message : "value must be JSON"
      });
    }
  })
  .transform((value) => value as { [key: string]: JsonValue });

export const ContextConfigSchema = z
  .object({
    files: z.array(NonEmptyStringSchema)
  })
  .strict();
export type ContextConfig = z.infer<typeof ContextConfigSchema>;

export const RepositoryConfigSchema = z
  .object({
    id: NonEmptyStringSchema,
    provider: NonEmptyStringSchema,
    owner: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    path: NonEmptyStringSchema,
    remote: NonEmptyStringSchema,
    expected_remote_urls: z.array(NonEmptyStringSchema).optional(),
    skills: z.array(SkillPathSchema).optional(),
    context: ContextConfigSchema.optional()
  })
  .strict();
export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>;

export const RepositoriesConfigSchema = z
  .object({
    repositories: z.array(RepositoryConfigSchema)
  })
  .strict();
export type RepositoriesConfig = z.infer<typeof RepositoriesConfigSchema>;

export const ModelProfileSchema = z
  .object({
    provider: NonEmptyStringSchema.optional(),
    model: NonEmptyStringSchema,
    reasoning_effort: z.enum(["low", "medium", "high"]),
    transport: z.enum(["auto", "sse", "websocket"]).optional()
  })
  .strict();
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const ModelsConfigSchema = z
  .object({
    model_profiles: z.record(NonEmptyStringSchema, ModelProfileSchema)
  })
  .strict();
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

export const WorkspaceConfigSchema = z
  .object({
    strategy: z.literal("git_worktree"),
    root: NonEmptyStringSchema,
    preserve_on_success: z.boolean(),
    preserve_on_failure: z.boolean()
  })
  .strict();
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

export const ArtifactsConfigSchema = z
  .object({
    root: NonEmptyStringSchema
  })
  .strict();
export type ArtifactsConfig = z.infer<typeof ArtifactsConfigSchema>;

export const RouterFileConfigSchema = z
  .object({
    path: NonEmptyStringSchema
  })
  .strict();
export type RouterFileConfig = z.infer<typeof RouterFileConfigSchema>;

export const LockConfigSchema = z
  .object({
    root: NonEmptyStringSchema.optional(),
    timeout_ms: z.number().int().positive().optional(),
    stale_after_ms: z.number().int().positive().optional()
  })
  .strict()
  .superRefine((locks, context) => {
    if (locks.stale_after_ms !== undefined) {
      const heartbeat = Math.min(30000, Math.floor(locks.stale_after_ms / 3));
      if (heartbeat < 1000) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "locks.stale_after_ms must allow heartbeat >= 1000ms",
          path: ["stale_after_ms"]
        });
      }
    }
  });
export type LockConfig = z.infer<typeof LockConfigSchema>;

export const AgentRuntimeConfigSchema = z
  .object({
    id: NonEmptyStringSchema,
    options: JsonObjectSchema.default({})
  })
  .strict();
export type AgentRuntimeConfig = z.infer<typeof AgentRuntimeConfigSchema>;

export const WorkflowRuntimeConfigSchema = AgentRuntimeConfigSchema;
export type WorkflowRuntimeConfig = z.infer<typeof WorkflowRuntimeConfigSchema>;

export const AppConfigSchema = z
  .object({
    workspace: WorkspaceConfigSchema,
    artifacts: ArtifactsConfigSchema,
    routing: RouterFileConfigSchema.optional(),
    locks: LockConfigSchema.optional(),
    workflow_runtime: WorkflowRuntimeConfigSchema.optional(),
    agent_runtime: AgentRuntimeConfigSchema.optional()
  })
  .strict();
export type AppConfig = z.infer<typeof AppConfigSchema>;
