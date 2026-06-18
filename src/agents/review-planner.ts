import { readFile } from "node:fs/promises";
import path from "node:path";
import { createAgent } from "@flue/runtime";
import YAML from "yaml";
import { z } from "zod";
import { loadYamlFile, resolveConfigRoot } from "../core/config-loader.js";
import { resolveModelProfiles, toFlueModelOptions } from "../core/model-config.js";
import { ModelsConfigSchema } from "../core/types.js";

const agentId = "review-planner";

export const description =
  "Builds a focused review plan from trusted repository context and untrusted pull request evidence.";

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
    path.join(process.cwd(), "agents/review-planner/agent.yaml"),
    "utf8"
  );

  return AgentConfigSchema.parse(YAML.parse(content));
}

async function loadInstructions(instructionsFile: string): Promise<string> {
  return await readFile(
    path.join(process.cwd(), "agents/review-planner", instructionsFile),
    "utf8"
  );
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
    instructions: await loadInstructions(agentConfig.instructions_file),
    ...toFlueModelOptions(profile)
  };
});
