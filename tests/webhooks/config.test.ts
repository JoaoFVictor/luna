import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadWebhookConfig,
  resolveWebhookConfigPath
} from "../../src/webhooks/config.js";
import {
  resolveProviderWebhookSecret,
  resolveSecretRef
} from "../../src/webhooks/secrets.js";

const baseConfig = `
version: "2026-06"
server:
  host: "127.0.0.1"
  port: 4012
  body_limit_bytes: 1048576
queue:
  name: "luna:webhooks"
  redis_url: "redis://127.0.0.1:6379"
  dedupe_ttl_seconds: 604800
  remove_on_complete:
    age_seconds: 86400
    count: 1000
  remove_on_fail: false
providers:
  github:
    enabled: true
    secret_ref: "providers.webhooks.github.secret"
  plane:
    enabled: true
    secret_ref: "providers.webhooks.plane.secret"
`;

describe("webhook config", () => {
  const originalRedisUrl = process.env.REDIS_URL;

  afterEach(() => {
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  });

  it("loads config/webhooks.yaml", async () => {
    await expect(loadWebhookConfig("config")).resolves.toMatchObject({
      version: "2026-06",
      server: {
        host: "127.0.0.1",
        port: 4012,
        body_limit_bytes: 1048576
      },
      queue: {
        name: "luna:webhooks",
        redis_url: "redis://127.0.0.1:6379",
        dedupe_ttl_seconds: 604800,
        remove_on_complete: {
          age_seconds: 86400
        }
      },
      worker: { concurrency: 8 },
      providers: {
        github: {
          enabled: true,
          secret_ref: "providers.webhooks.github.secret"
        },
        plane: {
          enabled: true,
          secret_ref: "providers.webhooks.plane.secret"
        }
      }
    });
  });

  it("resolves the default webhook config path", () => {
    expect(resolveWebhookConfigPath("/tmp/luna-config")).toBe(
      path.join("/tmp/luna-config", "webhooks.yaml")
    );
  });

  it("applies default worker concurrency 8 when omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "luna-webhook-config-"));

    try {
      await writeFile(join(root, "webhooks.yaml"), baseConfig, "utf8");

      await expect(loadWebhookConfig(root)).resolves.toMatchObject({
        worker: { concurrency: 8 }
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects worker concurrency 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "luna-webhook-config-"));

    try {
      await writeFile(
        join(root, "webhooks.yaml"),
        `${baseConfig}\nworker:\n  concurrency: 0\n`,
        "utf8"
      );

      await expect(loadWebhookConfig(root)).rejects.toMatchObject({
        code: "config_schema_invalid",
        path: join(root, "webhooks.yaml")
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not mutate loaded redis_url from REDIS_URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "luna-webhook-config-"));
    process.env.REDIS_URL = "redis://override.example:6379";

    try {
      await writeFile(join(root, "webhooks.yaml"), baseConfig, "utf8");

      const config = await loadWebhookConfig(root);

      expect(config.queue.redis_url).toBe("redis://127.0.0.1:6379");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("webhook secrets", () => {
  it("resolves providers.webhooks.github.secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "luna-webhook-auth-"));

    try {
      await writeFile(
        join(root, "luna.auth.json"),
        JSON.stringify({
          providers: {
            webhooks: {
              github: { secret: "github-secret" }
            }
          }
        }),
        "utf8"
      );

      await expect(
        resolveProviderWebhookSecret({
          projectRoot: root,
          secretRef: "providers.webhooks.github.secret"
        })
      ).resolves.toBe("github-secret");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects missing secrets without leaking sibling secret values", () => {
    const root = {
      providers: {
        webhooks: {
          github: { secret: "do-not-leak" }
        }
      }
    };

    expect(() => resolveSecretRef(root, "providers.webhooks.plane.secret"))
      .toThrowErrorMatchingInlineSnapshot(
        `[WebhookError: Missing webhook secret for ref: providers.webhooks.plane.secret]`
      );
  });
});
