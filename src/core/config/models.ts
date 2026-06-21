import type { ModelProfile, ModelsConfig } from "./schemas.js";

type ModelEnv = Record<string, string | undefined>;

export type ResolvedModelProfiles = Record<string, ModelProfile>;

const ENV_EXPRESSION = /^\$\{([A-Z0-9_]+)\}$/;
const ENV_FALLBACK_EXPRESSION = /^\$\{([A-Z0-9_]+):-([^}\s]+)\}$/;
const PLACEHOLDER_LIKE = /^\$\{|\}$/;
const MODEL_REFERENCE_SPEC = /^[^/\s]+\/[^/\s]+$/;

function errorWithCode(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;

  return error;
}

export function resolveModelProfiles(
  modelsConfig: ModelsConfig,
  env: ModelEnv = process.env
): ResolvedModelProfiles {
  const profiles: ResolvedModelProfiles = {};

  for (const [name, profile] of Object.entries(modelsConfig.model_profiles)) {
    if (Object.prototype.hasOwnProperty.call(profile, "env")) {
      throw errorWithCode(
        `Model profile ${name} must use model, not env`,
        "model_profile_env_unsupported"
      );
    }

    const expression = ENV_EXPRESSION.exec(profile.model);
    const fallbackExpression = ENV_FALLBACK_EXPRESSION.exec(profile.model);
    let resolvedModel = profile.model;

    if (
      expression === null &&
      fallbackExpression === null &&
      PLACEHOLDER_LIKE.test(profile.model)
    ) {
      throw errorWithCode(
        `Invalid model placeholder in profile ${name}`,
        "model_placeholder_invalid"
      );
    }

    if (fallbackExpression) {
      const modelFromEnv = env[fallbackExpression[1]];
      resolvedModel =
        typeof modelFromEnv === "string" && modelFromEnv.trim() !== ""
          ? modelFromEnv
          : fallbackExpression[2];
    } else if (expression) {
      const modelFromEnv = env[expression[1]];

      if (typeof modelFromEnv !== "string" || modelFromEnv.trim() === "") {
        throw errorWithCode(
          `Missing model environment variable ${expression[1]}`,
          "model_env_missing"
        );
      }

      resolvedModel = modelFromEnv;
    }

    if (!MODEL_REFERENCE_SPEC.test(resolvedModel)) {
      throw errorWithCode(
        `Model profile ${name} must use provider/model reference format`,
        "model_spec_invalid"
      );
    }

    profiles[name] = {
      ...profile,
      model: resolvedModel
    };
  }

  return profiles;
}
