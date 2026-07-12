import { access, readFile } from "node:fs/promises";
import YAML from "yaml";
import { ZodError } from "zod";
import type { JsonSchemaLike } from "../capabilities/json-schema-types.js";
import { matchesJsonSchema } from "../capabilities/json-schema.js";

export type ParseSchema<T> = {
  parse(value: unknown): T;
};

type ConfigEnv = {
  LUNA_CONFIG_ROOT?: string;
};

export type ConfigErrorCode =
  | "config_read_failed"
  | "config_parse_failed"
  | "config_schema_invalid";

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly path: string;

  constructor(
    message: string,
    code: ConfigErrorCode,
    path: string,
    cause: unknown
  ) {
    super(message, { cause });
    this.name = "ConfigError";
    this.code = code;
    this.path = path;
  }
}

class JsonSchemaConfigValidationError extends Error {
  constructor(readonly value: unknown) {
    super("Config value did not match JSON Schema");
  }
}

function configError(
  message: string,
  code: ConfigErrorCode,
  path: string,
  cause: unknown
): ConfigError {
  return new ConfigError(message, code, path, cause);
}

async function readConfig(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    throw configError(
      `Failed to read config file: ${path}`,
      "config_read_failed",
      path,
      cause
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw configError(
      `Failed to read config file: ${path}`,
      "config_read_failed",
      path,
      cause
    );
  }
}

function parseConfig<T>(
  path: string,
  content: string,
  parse: (content: string) => unknown,
  schema: ParseSchema<T>
): T {
  let parsed: unknown;

  try {
    parsed = parse(content);
  } catch (cause) {
    throw configError(
      `Failed to parse config file: ${path}`,
      "config_parse_failed",
      path,
      cause
    );
  }

  try {
    return schema.parse(parsed);
  } catch (cause) {
    if (
      cause instanceof ZodError ||
      cause instanceof JsonSchemaConfigValidationError
    ) {
      throw configError(
        `Config file failed schema validation: ${path}`,
        "config_schema_invalid",
        path,
        cause
      );
    }

    throw cause;
  }
}

export async function loadYamlFile<T>(
  path: string,
  schema: ParseSchema<T>
): Promise<T> {
  const content = await readConfig(path);

  return parseConfig(path, content, YAML.parse, schema);
}

export async function loadYamlJsonSchemaFile(
  path: string,
  schema: JsonSchemaLike
): Promise<unknown> {
  return await loadYamlFile(path, {
    parse(value: unknown): unknown {
      if (!matchesJsonSchema(schema, value)) {
        throw new JsonSchemaConfigValidationError(value);
      }

      return value;
    }
  });
}

export async function loadOptionalYamlFile<T>(
  path: string,
  schema: ParseSchema<T>
): Promise<T | undefined> {
  if (!(await pathExists(path))) {
    return undefined;
  }

  return await loadYamlFile(path, schema);
}

export async function loadJsonFile<T>(
  path: string,
  schema: ParseSchema<T>
): Promise<T> {
  const content = await readConfig(path);

  return parseConfig(path, content, JSON.parse, schema);
}

export function resolveConfigRoot(env: ConfigEnv = process.env): string {
  if (
    typeof env.LUNA_CONFIG_ROOT === "string" &&
    env.LUNA_CONFIG_ROOT.trim() !== ""
  ) {
    return env.LUNA_CONFIG_ROOT;
  }

  return "config";
}
