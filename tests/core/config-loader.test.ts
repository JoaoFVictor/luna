import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";
import {
  loadYamlFile,
  resolveConfigRoot
} from "../../src/core/config-loader.js";
import { resolveModelProfiles } from "../../src/core/model-config.js";
import {
  AppConfigSchema,
  ModelsConfigSchema,
  RepositoriesConfigSchema,
  RoutingConfigSchema
} from "../../src/core/types.js";

const configSchemas = {
  "app.yaml": AppConfigSchema,
  "models.yaml": ModelsConfigSchema,
  "repositories.yaml": RepositoriesConfigSchema,
  "routing.yaml": RoutingConfigSchema
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

  it("fails invalid YAML shape with a Zod error", async () => {
    const root = await mkdtemp(join(tmpdir(), "luna-config-"));
    const filePath = join(root, "invalid.yaml");

    try {
      await writeFile(filePath, "name: luna\ncount: nope\n", "utf8");

      const schema = z.object({
        name: z.literal("luna"),
        count: z.number()
      });

      await expect(loadYamlFile(filePath, schema)).rejects.toBeInstanceOf(
        ZodError
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uses config as the default config root", () => {
    expect(resolveConfigRoot({})).toBe("config");
  });

  it("allows LUNA_CONFIG_ROOT to override the default config root", () => {
    expect(resolveConfigRoot({ LUNA_CONFIG_ROOT: "/tmp/luna-config" })).toBe(
      "/tmp/luna-config"
    );
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

  it("models.yaml contains planner, reviewer, and acceptance profiles", async () => {
    const config = await loadYamlFile("config/models.yaml", ModelsConfigSchema);

    expect(Object.keys(config.model_profiles).sort()).toEqual([
      "acceptance",
      "planner",
      "reviewer"
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
        planner: {
          env: "PLANNER_MODEL",
          reasoning_effort: "medium"
        }
      }
    };

    expect(() => ModelsConfigSchema.parse(invalidConfig)).toThrow(ZodError);
  });

  it("resolves ${PLANNER_MODEL} from a provided environment map", async () => {
    const config = await loadYamlFile("config/models.yaml", ModelsConfigSchema);

    expect(
      resolveModelProfiles(config, {
        PLANNER_MODEL: "gpt-5-mini",
        REVIEWER_MODEL: "gpt-5",
        ACCEPTANCE_MODEL: "gpt-5-mini"
      }).planner.model
    ).toBe("gpt-5-mini");
  });

  it("throws model_env_missing when a model environment variable is missing", () => {
    const config = {
      model_profiles: {
        planner: {
          model: "${PLANNER_MODEL}",
          reasoning_effort: "medium"
        }
      }
    } as const;

    expect(() => resolveModelProfiles(config, {})).toThrow(
      expect.objectContaining({ code: "model_env_missing" })
    );
  });
});
