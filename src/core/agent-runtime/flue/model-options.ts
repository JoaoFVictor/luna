import type { ModelProfile } from "../../config/schemas.js";

export function toFlueModelOptions(profile: ModelProfile): {
  model: string;
  thinkingLevel: ModelProfile["reasoning_effort"];
} {
  return {
    model: profile.model,
    thinkingLevel: profile.reasoning_effort
  };
}

export function toFluePromptOptions(profile: ModelProfile): {
  model: string;
  thinkingLevel: ModelProfile["reasoning_effort"];
  transport?: NonNullable<ModelProfile["transport"]>;
} {
  return {
    ...toFlueModelOptions(profile),
    ...(profile.transport === undefined ? {} : { transport: profile.transport })
  };
}
