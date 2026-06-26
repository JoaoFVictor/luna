import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";
import {
  loadJsonFile,
  loadOptionalYamlFile,
  loadYamlFile,
  resolveConfigRoot
} from "../../src/core/config/loader.js";
import { McpConfigSchema } from "../../src/core/config/mcp.js";
import { resolveModelProfiles } from "../../src/core/config/models.js";
import { JiraConfigSchema } from "../../src/providers/jira/config.js";
import { PlaneConfigSchema } from "../../src/providers/plane/config.js";
import {
  AppConfigSchema,
  ModelsConfigSchema,
  RepositoriesConfigSchema
} from "../../src/core/config/schemas.js";
import { RouterDefinitionSchema } from "../../src/core/router/router-definition.js";
import { ImplementationConfigSchema } from "../../src/core/write-mode/types.js";

const configSchemas = {
  "app.yaml": AppConfigSchema,
  "implementation.yaml": ImplementationConfigSchema,
  "jira.yaml": JiraConfigSchema,
  "plane.yaml": PlaneConfigSchema,
  "mcp.yaml": McpConfigSchema,
  "models.yaml": ModelsConfigSchema,
  "repositories.yaml": RepositoriesConfigSchema,
  "routing.yaml": RouterDefinitionSchema
};

describe("config loader", () => {
  it("loads YAML config and validates it against a Zod schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "luna-config-"));
    const filePath = join(root, "sample.yaml");

    try {
      await writeFile(filePath, "name: luna\ncount: 3\n", "utf8");

      const schema = z.object({
        name: z.literal("luna"),
        count: z.number()
      });

      await expect(loadYamlFile(filePath, schema)).resolves.toEqual({
        name: "luna",
        count: 3
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails invalid YAML shape with config_schema_invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "luna-config-"));
    const filePath = join(root, "invalid.yaml");

    try {
      await writeFile(filePath, "name: luna\ncount: nope\n", "utf8");

      const schema = z.object({
        name: z.literal("luna"),
        count: z.number()
      });

      await expect(loadYamlFile(filePath, schema)).rejects.toMatchObject({
        code: "config_schema_invalid",
        path: filePath
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails invalid JSON parse with config_parse_failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "luna-config-"));
    const filePath = join(root, "invalid.json");

    try {
      await writeFile(filePath, "{ nope", "utf8");

      await expect(loadJsonFile(filePath, z.object({}))).rejects.toMatchObject({
        code: "config_parse_failed",
        path: filePath
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails invalid YAML parse with config_parse_failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "luna-config-"));
    const filePath = join(root, "invalid.yaml");

    try {
      await writeFile(filePath, "name: [unterminated\n", "utf8");

      await expect(loadYamlFile(filePath, z.object({}))).rejects.toMatchObject({
        code: "config_parse_failed",
        path: filePath
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails config read errors with config_read_failed", async () => {
    const filePath = join(tmpdir(), "luna-missing-config.yaml");

    await expect(loadYamlFile(filePath, z.object({}))).rejects.toMatchObject({
      code: "config_read_failed",
      path: filePath
    });
  });

  it("returns undefined for missing optional YAML files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-config-loader-"));

    await expect(
      loadOptionalYamlFile(
        path.join(root, "missing.yaml"),
        z.object({ enabled: z.boolean() })
      )
    ).resolves.toBeUndefined();
  });

  it("wraps optional YAML path access failures with config_read_failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-config-loader-"));
    const parentFilePath = path.join(root, "not-a-directory");
    const filePath = path.join(parentFilePath, "config.yaml");

    await writeFile(parentFilePath, "not a directory\n", "utf8");

    await expect(
      loadOptionalYamlFile(filePath, z.object({ enabled: z.boolean() }))
    ).rejects.toMatchObject({
      code: "config_read_failed",
      path: filePath
    });
  });

  it("uses config as the default config root", () => {
    expect(resolveConfigRoot({})).toBe("config");
  });

  it("allows LUNA_CONFIG_ROOT to override the default config root", () => {
    expect(resolveConfigRoot({ LUNA_CONFIG_ROOT: "/tmp/luna-config" })).toBe(
      "/tmp/luna-config"
    );
  });

  it("uses default config root for whitespace-only LUNA_CONFIG_ROOT", () => {
    expect(resolveConfigRoot({ LUNA_CONFIG_ROOT: "   " })).toBe("config");
  });

  it("parses every YAML file in the committed config directory", async () => {
    const files = (await readdir("config"))
      .filter((file) => file.endsWith(".yaml"))
      .sort();

    expect(files).toEqual(Object.keys(configSchemas).sort());

    await Promise.all(
      files.map(async (file) => {
        const schema = configSchemas[file as keyof typeof configSchemas] as z.ZodTypeAny;

        await expect(loadYamlFile(join("config", file), schema)).resolves.toEqual(
          expect.any(Object)
        );
      })
    );
  });

  it("models.yaml contains generic capability profiles", async () => {
    const config = await loadYamlFile("config/models.yaml", ModelsConfigSchema);

    expect(Object.keys(config.model_profiles).sort()).toEqual([
      "balanced",
      "deep",
      "default",
      "fast"
    ]);
  });

  it("requires every model profile to use model and never env", async () => {
    const config = await loadYamlFile("config/models.yaml", ModelsConfigSchema);

    for (const profile of Object.values(config.model_profiles)) {
      expect(profile).toHaveProperty("model");
      expect(profile).not.toHaveProperty("env");
    }

    const invalidConfig = {
      model_profiles: {
        default: {
          env: "DEFAULT_MODEL",
          reasoning_effort: "medium"
        }
      }
    };

    expect(() => ModelsConfigSchema.parse(invalidConfig)).toThrow(ZodError);
  });

  it("allows app.yaml to point at an alternate router file", () => {
    expect(
      AppConfigSchema.parse({
        workspace: {
          strategy: "git_worktree",
          root: "/tmp/luna-workspaces",
          preserve_on_success: false,
          preserve_on_failure: true
        },
        artifacts: {
          root: "/tmp/luna-artifacts"
        },
        routing: {
          path: "routing/custom.yaml"
        }
      })
    ).toMatchObject({
      routing: { path: "routing/custom.yaml" }
    });
  });

  it("resolves generic model profile fallbacks from a provided environment map", async () => {
    const config = await loadYamlFile("config/models.yaml", ModelsConfigSchema);

    expect(
      resolveModelProfiles(config, {
        DEFAULT_MODEL: "openai-codex/gpt-5.4-mini",
        DEEP_MODEL: "openai/gpt-5",
        FAST_MODEL: "openai-codex/gpt-5.3-codex-spark",
        BALANCED_MODEL: "openai-codex/gpt-5.4-mini"
      }).default.model
    ).toBe("openai-codex/gpt-5.4-mini");
  });

  it("throws model_env_missing when a model environment variable is missing", () => {
    const config = {
      model_profiles: {
        default: {
          model: "${DEFAULT_MODEL}",
          reasoning_effort: "medium"
        }
      }
    } as const;

    expect(() => resolveModelProfiles(config, {})).toThrow(
      expect.objectContaining({ code: "model_env_missing" })
    );
  });
});
