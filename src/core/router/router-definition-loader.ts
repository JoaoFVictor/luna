import { loadYamlFile } from "../config/loader.js";
import {
  AppConfigSchema,
  type AppConfig
} from "../config/schemas.js";
import { resolvePathInsideRoot } from "../security/path.js";
import {
  RouterDefinitionSchema,
  type RouterDefinition
} from "./router-definition.js";

const DEFAULT_ROUTING_PATH = "routing.yaml";
const MAX_ROUTING_PATH_LENGTH = 1_024;

export type RouterDefinitionLoadErrorCode =
  | "router_definition_path_invalid"
  | "router_definition_path_escape";

export class RouterDefinitionLoadError extends Error {
  readonly code: RouterDefinitionLoadErrorCode;

  constructor(
    code: RouterDefinitionLoadErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = "RouterDefinitionLoadError";
    this.code = code;
  }
}

function invalidRoutingPath(): RouterDefinitionLoadError {
  return new RouterDefinitionLoadError(
    "router_definition_path_invalid",
    "Routing configuration path is invalid"
  );
}

function normalizedRoutingSegments(value: string): readonly string[] {
  if (
    value.length === 0 ||
    value.length > MAX_ROUTING_PATH_LENGTH ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidRoutingPath();
  }

  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === ".." || /^[A-Za-z]:/u.test(segment)) {
      throw invalidRoutingPath();
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    throw invalidRoutingPath();
  }
  return segments;
}

async function resolveRoutingFile(
  configRoot: string,
  configuredPath: string
): Promise<string> {
  const segments = normalizedRoutingSegments(configuredPath);
  try {
    return await resolvePathInsideRoot(configRoot, segments);
  } catch (cause) {
    if ((cause as { readonly code?: unknown }).code === "path_security_violation") {
      throw new RouterDefinitionLoadError(
        "router_definition_path_escape",
        "Routing configuration path resolves outside the config root",
        cause
      );
    }
    throw cause;
  }
}

async function appConfig(
  configRoot: string,
  injected: AppConfig | undefined
): Promise<AppConfig> {
  if (injected !== undefined) {
    return AppConfigSchema.parse(injected);
  }
  return await loadYamlFile(
    await resolveRoutingFile(configRoot, "app.yaml"),
    AppConfigSchema
  );
}

export async function loadRouterDefinition(input: {
  readonly configRoot: string;
  readonly app?: AppConfig;
}): Promise<RouterDefinition> {
  const app = await appConfig(input.configRoot, input.app);
  const routingPath = app.routing?.path ?? DEFAULT_ROUTING_PATH;
  return await loadYamlFile(
    await resolveRoutingFile(input.configRoot, routingPath),
    RouterDefinitionSchema
  );
}
