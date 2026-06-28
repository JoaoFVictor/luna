import { describe, expect, it } from "vitest";
import { resolveModelProfiles } from "../../src/core/config/models.js";
import type { ModelsConfig } from "../../src/core/config/schemas.js";

describe("model config", () => {
  it("resolves model profiles to concrete model names", () => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        default: {
          model: "${DEFAULT_MODEL}",
          reasoning_effort: "medium",
          transport: "sse"
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
        reasoning_effort: "medium",
        transport: "sse"
      },
      deep: {
        model: "openai/gpt-5",
        reasoning_effort: "high"
      }
    });
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

  it("throws model_spec_invalid for an environment model without provider prefix", () => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        deep: {
          model: "${DEEP_MODEL}",
          reasoning_effort: "high"
        }
      }
    };

    expect(() =>
      resolveModelProfiles(modelsConfig, { DEEP_MODEL: "gpt-5" })
    ).toThrow(expect.objectContaining({ code: "model_spec_invalid" }));
  });

  it("throws model_placeholder_invalid for a malformed placeholder", () => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        default: {
          model: "${DEFAULT_MODEL }",
          reasoning_effort: "medium"
        }
      }
    };

    expect(() => resolveModelProfiles(modelsConfig, {})).toThrow(
      expect.objectContaining({ code: "model_placeholder_invalid" })
    );
  });
});
