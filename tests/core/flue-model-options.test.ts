import { describe, expect, it } from "vitest";
import {
  toFlueModelOptions,
  toFluePromptOptions
} from "../../src/core/agent-runtime/flue/model-options.js";

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

  it("does not pass transport to Flue runtime model options", () => {
    expect(
      toFlueModelOptions({
        model: "openai-codex/gpt-5.4",
        reasoning_effort: "high",
        transport: "sse"
      })
    ).toEqual({
      model: "openai-codex/gpt-5.4",
      thinkingLevel: "high"
    });
  });

  it("passes configured transport through to prompt options", () => {
    expect(
      toFluePromptOptions({
        model: "openai-codex/gpt-5.4",
        reasoning_effort: "high",
        transport: "sse"
      })
    ).toEqual({
      model: "openai-codex/gpt-5.4",
      thinkingLevel: "high",
      transport: "sse"
    });
  });
});
