import {
  runLunaWorkflowWithFlue,
  type ConfiguredWorkflowResult
} from "../core/agent-runtime/flue/workflow-factory.js";

type LunaFlueContext = Parameters<typeof runLunaWorkflowWithFlue>[0];

export async function runWithFlue(
  ctx: LunaFlueContext
): Promise<ConfiguredWorkflowResult> {
  return await runLunaWorkflowWithFlue(ctx);
}

export async function run(
  ctx: LunaFlueContext
): Promise<ConfiguredWorkflowResult> {
  return await runWithFlue(ctx);
}
