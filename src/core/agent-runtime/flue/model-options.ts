import type { ModelProfile } from "../../types.js";

export function toFlueModelOptions(profile: ModelProfile): {
  model: string;
  thinkingLevel: ModelProfile["reasoning_effort"];
} {
  return {
    model: profile.model,
    thinkingLevel: profile.reasoning_effort
  };
}
