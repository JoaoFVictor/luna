import path from "node:path";
import { z } from "zod";
import { loadYamlFile } from "../core/config/loader.js";

const WebhookProviderConfigSchema = z
  .object({
    enabled: z.boolean(),
    secret_ref: z.string().min(1)
  })
  .strict();

export const WebhookConfigSchema = z
  .object({
    version: z.literal("2026-06"),
    server: z
      .object({
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535),
        body_limit_bytes: z.number().int().min(1)
      })
      .strict(),
    queue: z
      .object({
        name: z.string().min(1),
        redis_url: z.string().url(),
        dedupe_ttl_seconds: z.number().int().min(1),
        remove_on_complete: z
          .object({
            age_seconds: z.number().int().min(1),
            count: z.number().int().min(1)
          })
          .strict(),
        remove_on_fail: z.boolean()
      })
      .strict(),
    worker: z
      .object({
        concurrency: z.number().int().min(1).default(8)
      })
      .strict()
      .default({ concurrency: 8 }),
    providers: z.record(WebhookProviderConfigSchema)
  })
  .strict();

export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;

export function resolveWebhookConfigPath(configRoot: string): string {
  return path.join(configRoot, "webhooks.yaml");
}

export async function loadWebhookConfig(
  configRoot: string
): Promise<WebhookConfig> {
  return await loadYamlFile(resolveWebhookConfigPath(configRoot), WebhookConfigSchema);
}
