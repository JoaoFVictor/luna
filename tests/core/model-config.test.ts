import { describe, expect, it } from "vitest";
import {
  resolveModelProfiles,
  toFlueModelOptions
} from "../../src/core/model-config.js";
import type { ModelsConfig } from "../../src/core/types.js";

describe("model config", () => {
  it("resolves model profiles to concrete model names", () => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        planner: {
          model: "${PLANNER_MODEL}",
          reasoning_effort: "medium"
        },
        reviewer: {
          model: "openai/gpt-5",
          reasoning_effort: "high"
        }
      }
    };

    expect(
      resolveModelProfiles(modelsConfig, { PLANNER_MODEL: "openai/gpt-5-mini" })
    ).toEqual({
      planner: {
        model: "openai/gpt-5-mini",
        reasoning_effort: "medium"
      },
      reviewer: {
        model: "openai/gpt-5",
        reasoning_effort: "high"
      }
    });
  });

  it("accepts model: openai/gpt-5-mini without environment lookup", () => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        planner: {
          model: "openai/gpt-5-mini",
          reasoning_effort: "medium"
        }
      }
    };

    expect(resolveModelProfiles(modelsConfig, {}).planner.model).toBe(
      "openai/gpt-5-mini"
    );
  });

  it("resolves model: ${REVIEWER_MODEL} from env.REVIEWER_MODEL", () => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        reviewer: {
          model: "${REVIEWER_MODEL}",
          reasoning_effort: "high"
        }
      }
    };

    expect(
      resolveModelProfiles(modelsConfig, { REVIEWER_MODEL: "openai/gpt-5" }).reviewer
        .model
    ).toBe("openai/gpt-5");
  });

  it("throws model_env_missing for model: ${MISSING_MODEL}", () => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        reviewer: {
          model: "${MISSING_MODEL}",
          reasoning_effort: "high"
        }
      }
    };

    expect(() => resolveModelProfiles(modelsConfig, {})).toThrow(
      expect.objectContaining({ code: "model_env_missing" })
    );
  });

  it("throws model_env_missing for whitespace-only environment values", () => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        planner: {
          model: "${PLANNER_MODEL}",
          reasoning_effort: "medium"
        }
      }
    };

    expect(() =>
      resolveModelProfiles(modelsConfig, { PLANNER_MODEL: "   " })
    ).toThrow(expect.objectContaining({ code: "model_env_missing" }));
  });

  it.each([
    ["direct model", "gpt-5"],
    ["environment model", "${REVIEWER_MODEL}"]
  ])("throws model_spec_invalid for %s without provider prefix", (_case, model) => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        reviewer: {
          model,
          reasoning_effort: "high"
        }
      }
    };

    expect(() =>
      resolveModelProfiles(modelsConfig, { REVIEWER_MODEL: "gpt-5" })
    ).toThrow(expect.objectContaining({ code: "model_spec_invalid" }));
  });

  it.each(["${PLANNER_MODEL }", "${planner_model}", "${PLANNER_MODEL"])(
    "throws model_placeholder_invalid for malformed placeholder %s",
    (model) => {
      const modelsConfig: ModelsConfig = {
        model_profiles: {
          planner: {
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

  it("maps reasoning_effort low to thinkingLevel low", () => {
    expect(
      toFlueModelOptions({ model: "openai/gpt-5-mini", reasoning_effort: "low" })
    ).toEqual({ model: "openai/gpt-5-mini", thinkingLevel: "low" });
  });

  it("maps reasoning_effort medium to thinkingLevel medium", () => {
    expect(
      toFlueModelOptions({ model: "openai/gpt-5-mini", reasoning_effort: "medium" })
    ).toEqual({ model: "openai/gpt-5-mini", thinkingLevel: "medium" });
  });

  it("maps reasoning_effort high to thinkingLevel high", () => {
    expect(
      toFlueModelOptions({ model: "openai/gpt-5", reasoning_effort: "high" })
    ).toEqual({ model: "openai/gpt-5", thinkingLevel: "high" });
  });
});
