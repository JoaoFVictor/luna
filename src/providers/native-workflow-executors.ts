import path from "node:path";
import { createChangeRequestProviderRegistry } from "../capabilities/change-request/provider-registry.js";
import { qualityGatePatternExecutors } from "../capabilities/quality-gates/workflow-pattern-executor.js";
import { builtInStepNameForWorkflowCapability } from "../core/built-ins/workflow-aliases.js";
import type { AppConfig } from "../core/config/schemas.js";
import type { RunHandle } from "../core/runtime/run-handle.js";
import { RunLockManager } from "../core/workflow/lock-manager.js";
import { createGitRepositoryPorts } from "../runtime/git/repository-port.js";
import { createGitHubChangeRequestProviderFactory } from "./github/change-request/factory.js";
import {
  defaultProviderBuiltInStepRegistry,
  defaultProviderWorkflowBuiltIns
} from "./built-ins.js";

export function buildNativeWorkflowExecutors({
  app,
  projectRoot,
  run
}: {
  readonly app: AppConfig;
  readonly projectRoot: string;
  readonly run: RunHandle;
}) {
  return {
    builtIns: defaultProviderWorkflowBuiltIns({
      git: createGitRepositoryPorts(),
      changeRequest: {
        providers: createChangeRequestProviderRegistry([
          createGitHubChangeRequestProviderFactory({})
        ])
      }
    }),
    patternExecutors: qualityGatePatternExecutors,
    builtInMetadata: (node: { readonly capability_id: string }) => {
      const name = builtInStepNameForWorkflowCapability(node.capability_id);
      return defaultProviderBuiltInStepRegistry.has(name)
        ? defaultProviderBuiltInStepRegistry.require(name).metadata ?? {}
        : {};
    },
    lockManager: new RunLockManager({
      root: lockRoot(app, projectRoot),
      runId: run.run_id,
      timeoutMs: app.locks?.timeout_ms ?? 300_000,
      staleAfterMs: app.locks?.stale_after_ms ?? 900_000
    })
  };
}

function lockRoot(app: AppConfig, projectRoot: string): string {
  return path.resolve(
    projectRoot,
    app.locks?.root ?? path.join(app.artifacts.root, "locks")
  );
}
