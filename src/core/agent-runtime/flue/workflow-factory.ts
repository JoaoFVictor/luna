import type { FlueContext } from "@flue/runtime";
import {
  runConfiguredWorkflow,
  type ConfiguredWorkflowResult
} from "../../configured-workflow-runner.js";
import { loadMcpConfig } from "../../mcp-config.js";
import type { Invocation } from "../../types.js";
import { createFlueAgentRunner } from "./runner.js";
import { createFlueLogSink } from "./observability.js";
import { registerConfiguredPiOAuthProviders } from "./pi-auth.js";

export type { ConfiguredWorkflowResult };

export async function runLunaWorkflowWithFlue(
  ctx: FlueContext<Invocation>
): Promise<ConfiguredWorkflowResult> {
  const configRoot = process.env.LUNA_CONFIG_ROOT ?? "config";
  const projectRoot = process.env.LUNA_PROJECT_ROOT ?? process.cwd();
  await registerConfiguredPiOAuthProviders({ configRoot });
  const mcpConfig = await loadMcpConfig(configRoot);

  return await runConfiguredWorkflow({
    invocation: ctx.payload,
    configRoot,
    projectRoot,
    flueRunId: ctx.id,
    observabilitySinks: [createFlueLogSink(ctx.log)],
    dependencies: createFlueAgentRunner({ ctx, mcpConfig })
  });
}
