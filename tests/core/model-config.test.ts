import { describe, expect, it } from "vitest";
import { resolveModelProfiles } from "../../src/core/model-config.js";
import type { ModelsConfig } from "../../src/core/types.js";

describe("model config", () => {
  it("resolves model profiles to concrete model names", () => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        default: {
          model: "${DEFAULT_MODEL}",
          reasoning_effort: "medium"
        },
        deep: {
          model: "openai/gpt-5",
          reasoning_effort: "high"
        }
      }
    };

    expect(
      resolveModelProfiles(modelsConfig, { DEFAULT_MODEL: "openai-codex/gpt-5.4-mini" })
    ).toEqual({
      default: {
        model: "openai-codex/gpt-5.4-mini",
        reasoning_effort: "medium"
      },
      deep: {
        model: "openai/gpt-5",
        reasoning_effort: "high"
      }
    });
  });

  it("accepts model: openai-codex/gpt-5.4-mini without environment lookup", () => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        default: {
          model: "openai-codex/gpt-5.4-mini",
          reasoning_effort: "medium"
        }
      }
    };

    expect(resolveModelProfiles(modelsConfig, {}).default.model).toBe(
      "openai-codex/gpt-5.4-mini"
    );
  });

  it("resolves model: ${DEEP_MODEL} from env.DEEP_MODEL", () => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        deep: {
          model: "${DEEP_MODEL}",
          reasoning_effort: "high"
        }
      }
    };

    expect(
      resolveModelProfiles(modelsConfig, { DEEP_MODEL: "openai/gpt-5" }).deep
        .model
    ).toBe("openai/gpt-5");
  });

  it("resolves model fallback placeholders from the environment when present", () => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        deep: {
          model: "${DEEP_MODEL:-openai-codex/gpt-5.4-mini}",
          reasoning_effort: "high"
        }
      }
    };

    expect(
      resolveModelProfiles(modelsConfig, { DEEP_MODEL: "openai/gpt-5" })
        .deep.model
    ).toBe("openai/gpt-5");
  });

  it("resolves model fallback placeholders to the configured default", () => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        default: {
          model: "${DEFAULT_MODEL:-openai-codex/gpt-5.4-mini}",
          reasoning_effort: "medium"
        }
      }
    };

    expect(resolveModelProfiles(modelsConfig, {}).default.model).toBe(
      "openai-codex/gpt-5.4-mini"
    );
  });

  it("throws model_env_missing for model: ${MISSING_MODEL}", () => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        deep: {
          model: "${MISSING_MODEL}",
          reasoning_effort: "high"
        }
      }
    };

    expect(() => resolveModelProfiles(modelsConfig, {})).toThrow(
      expect.objectContaining({ code: "model_env_missing" })
    );
  });

  it("throws model_spec_invalid when a model fallback default lacks a provider", () => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        default: {
          model: "${DEFAULT_MODEL:-gpt-5-mini}",
          reasoning_effort: "medium"
        }
      }
    };

    expect(() => resolveModelProfiles(modelsConfig, {})).toThrow(
      expect.objectContaining({ code: "model_spec_invalid" })
    );
  });

  it("throws model_env_missing for whitespace-only environment values", () => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        default: {
          model: "${DEFAULT_MODEL}",
          reasoning_effort: "medium"
        }
      }
    };

    expect(() =>
      resolveModelProfiles(modelsConfig, { DEFAULT_MODEL: "   " })
    ).toThrow(expect.objectContaining({ code: "model_env_missing" }));
  });

  it.each([
    ["direct model", "gpt-5"],
    ["environment model", "${DEEP_MODEL}"]
  ])("throws model_spec_invalid for %s without provider prefix", (_case, model) => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        deep: {
          model,
          reasoning_effort: "high"
        }
      }
    };

    expect(() =>
      resolveModelProfiles(modelsConfig, { DEEP_MODEL: "gpt-5" })
    ).toThrow(expect.objectContaining({ code: "model_spec_invalid" }));
  });

  it.each(["${DEFAULT_MODEL }", "${default_model}", "${DEFAULT_MODEL"])(
    "throws model_placeholder_invalid for malformed placeholder %s",
    (model) => {
      const modelsConfig: ModelsConfig = {
        model_profiles: {
          default: {
            model,
            reasoning_effort: "medium"
          }
        }
      };

      expect(() => resolveModelProfiles(modelsConfig, {})).toThrow(
        expect.objectContaining({ code: "model_placeholder_invalid" })
      );
    }
  );
});
