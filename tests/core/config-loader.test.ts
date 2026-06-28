import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  loadJsonFile,
  loadOptionalYamlFile,
  loadYamlFile
} from "../../src/core/config/loader.js";
describe("config loader", () => {
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

});
