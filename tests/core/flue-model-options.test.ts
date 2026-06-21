import { describe, expect, it } from "vitest";
import { toFlueModelOptions } from "../../src/core/agent-runtime/flue/model-options.js";

describe("Flue model options", () => {
  it.each([
    ["low", "openai-codex/gpt-5.4-mini"],
    ["medium", "openai-codex/gpt-5.4-mini"],
    ["high", "openai/gpt-5"]
  ] as const)(
    "maps reasoning_effort %s to thinkingLevel %s",
    (reasoningEffort, model) => {
      expect(
        toFlueModelOptions({
          model,
          reasoning_effort: reasoningEffort
        })
      ).toEqual({ model, thinkingLevel: reasoningEffort });
    }
  );
});
