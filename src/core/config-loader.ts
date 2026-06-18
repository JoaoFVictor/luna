import { readFile } from "node:fs/promises";
import YAML from "yaml";

type ParseSchema<T> = {
  parse(value: unknown): T;
};

type ConfigEnv = {
  LUNA_CONFIG_ROOT?: string;
};

export async function loadYamlFile<T>(
  path: string,
  schema: ParseSchema<T>
): Promise<T> {
  const content = await readFile(path, "utf8");
  const parsed = YAML.parse(content);

  return schema.parse(parsed);
}

export async function loadJsonFile<T>(
  path: string,
  schema: ParseSchema<T>
): Promise<T> {
  const content = await readFile(path, "utf8");
  const parsed = JSON.parse(content);

  return schema.parse(parsed);
}

export function resolveConfigRoot(env: ConfigEnv = process.env): string {
  if (typeof env.LUNA_CONFIG_ROOT === "string" && env.LUNA_CONFIG_ROOT !== "") {
    return env.LUNA_CONFIG_ROOT;
  }

  return "config";
}
