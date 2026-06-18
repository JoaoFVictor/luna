import { readFile } from "node:fs/promises";
import path from "node:path";
import { createAgent } from "@flue/runtime";
import instructions from "../../agents/code-reviewer/instructions.md" with { type: "markdown" };
import YAML from "yaml";
import { z } from "zod";
import { loadYamlFile, resolveConfigRoot } from "../core/config-loader.js";
import { resolveModelProfiles, toFlueModelOptions } from "../core/model-config.js";
import { ModelsConfigSchema } from "../core/types.js";

const agentId = "code-reviewer";

export const description =
  "Reviews pull request code for concrete defects using verified repository evidence.";

const AgentConfigSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    model_profile: z.string().min(1),
    instructions_file: z.string().min(1)
  })
  .passthrough();

function codedError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

async function loadAgentConfig() {
  const content = await readFile(
    new URL("../../agents/code-reviewer/agent.yaml", import.meta.url),
    "utf8"
  );

  return AgentConfigSchema.parse(YAML.parse(content));
}

export default createAgent(async () => {
  const agentConfig = await loadAgentConfig();
  const configRoot = resolveConfigRoot(process.env);
  const modelsConfig = await loadYamlFile(
    path.join(configRoot, "models.yaml"),
    ModelsConfigSchema
  );
  const modelProfiles = resolveModelProfiles(modelsConfig, process.env);
  const profile = modelProfiles[agentConfig.model_profile];

  if (profile === undefined) {
    throw codedError(
      `Model profile ${agentConfig.model_profile} is not configured for ${agentId}`,
      "model_profile_missing"
    );
  }

  return {
    description,
    instructions,
    ...toFlueModelOptions(profile)
  };
});
