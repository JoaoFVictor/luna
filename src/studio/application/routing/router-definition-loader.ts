import type { AppConfig } from "../../../core/config/schemas.js";
import {
  loadRouterDefinition,
  RouterDefinitionLoadError
} from "../../../core/router/router-definition-loader.js";
import {
  RouterDefinitionSchema,
  type RouterDefinition
} from "../../../core/router/router-definition.js";

export type StudioRoutingDefinitionSource =
  | {
      readonly definition: unknown;
    }
  | {
      readonly configRoot: string;
      readonly app?: AppConfig;
    };

export type StudioRoutingDefinitionLoadErrorCode =
  | "studio_routing_path_invalid"
  | "studio_routing_path_escape"
  | "studio_routing_load_failed";

export class StudioRoutingDefinitionLoadError extends Error {
  readonly code: StudioRoutingDefinitionLoadErrorCode;

  constructor(
    code: StudioRoutingDefinitionLoadErrorCode,
    message: string
  ) {
    super(message);
    this.name = "StudioRoutingDefinitionLoadError";
    this.code = code;
  }
}

function publicLoadError(cause: unknown): StudioRoutingDefinitionLoadError {
  if (cause instanceof RouterDefinitionLoadError) {
    return cause.code === "router_definition_path_invalid"
      ? new StudioRoutingDefinitionLoadError(
          "studio_routing_path_invalid",
          "Routing configuration path is invalid"
        )
      : new StudioRoutingDefinitionLoadError(
          "studio_routing_path_escape",
          "Routing configuration path escapes the configured root"
        );
  }

  return new StudioRoutingDefinitionLoadError(
    "studio_routing_load_failed",
    "Routing configuration could not be loaded"
  );
}

export async function loadStudioRoutingDefinition(
  source: StudioRoutingDefinitionSource
): Promise<RouterDefinition> {
  try {
    if ("definition" in source) {
      return RouterDefinitionSchema.parse(source.definition);
    }
    return await loadRouterDefinition({
      configRoot: source.configRoot,
      ...(source.app === undefined ? {} : { app: source.app })
    });
  } catch (cause) {
    throw publicLoadError(cause);
  }
}
