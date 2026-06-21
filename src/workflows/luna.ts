import type { FlueContext } from "@flue/runtime";
import {
  runConfiguredWorkflow,
  type ConfiguredWorkflowResult
} from "../core/configured-workflow-runner.js";
import { createFlueAgentRunner } from "../core/flue-agent-runner.js";
import { loadMcpConfig } from "../core/mcp-config.js";
import { createFlueLogSink } from "../core/observability/flue-log-sink.js";
import { registerConfiguredPiOAuthProviders } from "../core/pi-auth.js";
import type { Invocation } from "../core/types.js";

export async function runWithFlue(
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

export async function run(
  ctx: FlueContext<Invocation>
): Promise<ConfiguredWorkflowResult> {
  return await runWithFlue(ctx);
}
