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
import {
  createFlueGatedAgentLoopRunner,
  runFlueAgentRuntimeInput
} from "./runner.js";
import { createFlueLogSink } from "./observability.js";
import { registerConfiguredPiOAuthProviders } from "./pi-auth.js";
import { createNodeLocalExecPorts } from "../../local-exec/node-ports.js";
import { createGitHubRepositoryWorkspacePorts } from "../../providers/github/repository-workspace.js";
import { createGitRepositoryPorts } from "../../../runtime/git/repository-port.js";
import { createDefaultChangeRequestPorts } from "../../../runtime/change-request/providers.js";
import { createFlueAgentRuntimeAdapter } from "../../../agent-runtimes/flue/adapter.js";
import { resolveToolCatalog } from "../../tools/resolved-catalog.js";
import { lunaToolCatalog } from "../../tools/catalog.js";
import { officialCapabilityRegistry } from "../../../capabilities/registry.js";

export type { ConfiguredWorkflowResult };

export async function runLunaWorkflowWithFlue(
  ctx: FlueContext<Invocation>
): Promise<ConfiguredWorkflowResult> {
  const configRoot = process.env.LUNA_CONFIG_ROOT ?? "config";
  const projectRoot = process.env.LUNA_PROJECT_ROOT ?? process.cwd();
  const runtimeRunId = ctx.id ?? "flue-local-run";
  await registerConfiguredPiOAuthProviders({ configRoot });
  const mcpConfig = await loadMcpConfig(configRoot);

  const gatedAgentLoopRunner = createFlueGatedAgentLoopRunner({ ctx, mcpConfig });
  const agentRuntime = createFlueAgentRuntimeAdapter({
    runner: async (input) => await runFlueAgentRuntimeInput(ctx, input, mcpConfig)
  });

  return await runConfiguredWorkflow({
    invocation: ctx.payload,
    configRoot,
    projectRoot,
    runtimeRunId,
    observabilitySinks: [createFlueLogSink(ctx.log)],
    dependencies: {
      agentRuntime,
      resolveAgentTools: ({ agent }) =>
        resolveToolCatalog({
          registry: officialCapabilityRegistry,
          local_tools: lunaToolCatalog,
          requested_local_tool_ids: agent.tools ?? [],
          requested_mcp_server_ids: agent.mcp_servers ?? [],
          agent_mode: agent.mode,
          mcp_config: mcpConfig
        }),
      runGatedAgentLoopStep: gatedAgentLoopRunner.runGatedAgentLoopStep,
      builtInStepDependencies: {
        git: createGitRepositoryPorts(),
        changeRequest: createDefaultChangeRequestPorts(),
        localExec: createNodeLocalExecPorts({
          projectRoot,
          runId: runtimeRunId,
          log: ctx.log
        })
      },
      builtInStepRegistry: defaultProviderBuiltInStepRegistry,
      repositoryWorkspacePortFactory: createGitHubRepositoryWorkspacePorts,
      runBuiltInStep
    }
  });
}
