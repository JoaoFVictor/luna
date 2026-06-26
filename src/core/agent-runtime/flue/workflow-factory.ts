import type { FlueContext } from "@flue/runtime";
import {
  runConfiguredWorkflow,
  type ConfiguredWorkflowResult
} from "../../configured-workflow/runner.js";
import { loadMcpConfig } from "../../config/mcp.js";
import type { Invocation } from "../../router/invocation.js";
import {
  defaultProviderBuiltInStepRegistry,
  runBuiltInStep
} from "../../providers/built-ins.js";
import { createFlueAgentRunner } from "./runner.js";
import { createFlueLogSink } from "./observability.js";
import { registerConfiguredPiOAuthProviders } from "./pi-auth.js";
import { createNodeLocalExecPorts } from "../../local-exec/node-ports.js";

export type { ConfiguredWorkflowResult };

export async function runLunaWorkflowWithFlue(
  ctx: FlueContext<Invocation>
): Promise<ConfiguredWorkflowResult> {
  const configRoot = process.env.LUNA_CONFIG_ROOT ?? "config";
  const projectRoot = process.env.LUNA_PROJECT_ROOT ?? process.cwd();
  const runtimeRunId = ctx.id ?? "flue-local-run";
  await registerConfiguredPiOAuthProviders({ configRoot });
  const mcpConfig = await loadMcpConfig(configRoot);

  const agentRunner = createFlueAgentRunner({ ctx, mcpConfig });

  return await runConfiguredWorkflow({
    invocation: ctx.payload,
    configRoot,
    projectRoot,
    runtimeRunId,
    observabilitySinks: [createFlueLogSink(ctx.log)],
    dependencies: {
      ...agentRunner,
      builtInStepDependencies: {
        localExec: createNodeLocalExecPorts({
          projectRoot,
          runId: runtimeRunId,
          log: ctx.log
        })
      },
      builtInStepRegistry: defaultProviderBuiltInStepRegistry,
      runBuiltInStep
    }
  });
}
