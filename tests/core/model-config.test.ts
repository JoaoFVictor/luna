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
          model: "gpt-5",
          reasoning_effort: "high"
        }
      }
    };

    expect(
      resolveModelProfiles(modelsConfig, { PLANNER_MODEL: "gpt-5-mini" })
    ).toEqual({
      planner: {
        model: "gpt-5-mini",
        reasoning_effort: "medium"
      },
      reviewer: {
        model: "gpt-5",
        reasoning_effort: "high"
      }
    });
  });

  it("accepts model: gpt-5-mini without environment lookup", () => {
    const modelsConfig: ModelsConfig = {
      model_profiles: {
        planner: {
          model: "gpt-5-mini",
          reasoning_effort: "medium"
        }
      }
    };

    expect(resolveModelProfiles(modelsConfig, {}).planner.model).toBe(
      "gpt-5-mini"
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
      resolveModelProfiles(modelsConfig, { REVIEWER_MODEL: "gpt-5" }).reviewer
        .model
    ).toBe("gpt-5");
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

  it("maps reasoning_effort low to thinkingLevel low", () => {
    expect(
      toFlueModelOptions({ model: "gpt-5-mini", reasoning_effort: "low" })
    ).toEqual({ model: "gpt-5-mini", thinkingLevel: "low" });
  });

  it("maps reasoning_effort medium to thinkingLevel medium", () => {
    expect(
      toFlueModelOptions({ model: "gpt-5-mini", reasoning_effort: "medium" })
    ).toEqual({ model: "gpt-5-mini", thinkingLevel: "medium" });
  });

  it("maps reasoning_effort high to thinkingLevel high", () => {
    expect(
      toFlueModelOptions({ model: "gpt-5", reasoning_effort: "high" })
    ).toEqual({ model: "gpt-5", thinkingLevel: "high" });
  });
});
