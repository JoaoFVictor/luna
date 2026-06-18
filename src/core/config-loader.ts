import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { ZodError } from "zod";

type ParseSchema<T> = {
  parse(value: unknown): T;
};

type ConfigEnv = {
  LUNA_CONFIG_ROOT?: string;
};

type ConfigErrorCode =
  | "config_read_failed"
  | "config_parse_failed"
  | "config_schema_invalid";

type ConfigError = Error & {
  code: ConfigErrorCode;
  path: string;
  cause: unknown;
};

function configError(
  message: string,
  code: ConfigErrorCode,
  path: string,
  cause: unknown
): ConfigError {
  const error = new Error(message, { cause }) as ConfigError;
  error.code = code;
  error.path = path;

  return error;
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
    if (cause instanceof ZodError) {
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
