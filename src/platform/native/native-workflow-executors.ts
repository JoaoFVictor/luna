import path from "node:path";
import { officialCapabilityRegistry } from "../../capabilities/registry.js";
import { createChangeRequestProviderRegistry } from "../../capabilities/change-request/provider-registry.js";
import type { CapabilityRegistry } from "../../core/capabilities/registry.js";
import type { ChangeRequestProviderFactory } from "../../core/change-request/contracts.js";
import type { TaskProviderBuiltIns } from "../../providers/built-ins.js";
import type { AppConfig } from "../../core/config/schemas.js";
import { runtimeError } from "../../core/runtime/errors.js";
import type { RunHandle } from "../../core/runtime/run-handle.js";
import type { WorkflowPatternExecutor } from "../../core/workflow/execution-contracts.js";
import { RunLockManager } from "../../core/workflow/lock-manager.js";
import { createGitRepositoryPorts } from "../../runtime/git/repository-port.js";
import {
  createNativeProviderBuiltIns
} from "./native-built-ins.js";
import type { NativeWorkflowBuiltIns } from "./native-platform-plugins.js";
import { nativeLunaPlatformRegistrations } from "./native-platform-registrations.js";

type NativeWorkflowExecutorCoverage = {
  readonly builtIns: Readonly<Record<string, unknown>>;
  readonly patternExecutors: Readonly<Record<string, unknown>>;
  readonly capabilityRegistry?: CapabilityRegistry;
};

export function buildNativeWorkflowExecutors({
  app,
  projectRoot,
  run,
  changeRequestProviderFactories =
    nativeLunaPlatformRegistrations.changeRequestProviderFactories,
  patternExecutors = nativeLunaPlatformRegistrations.patternExecutors ?? {},
  workflowBuiltIns,
  taskProviderBuiltIns,
  capabilityRegistry = officialCapabilityRegistry
}: {
  readonly app: AppConfig;
  readonly projectRoot: string;
  readonly run: RunHandle;
  readonly changeRequestProviderFactories?: readonly ChangeRequestProviderFactory[];
  readonly patternExecutors?: Readonly<Record<string, WorkflowPatternExecutor>>;
  readonly workflowBuiltIns?: NativeWorkflowBuiltIns;
  readonly taskProviderBuiltIns?: Readonly<Record<string, TaskProviderBuiltIns>>;
  readonly capabilityRegistry?: CapabilityRegistry;
}) {
  const providerBuiltIns = createNativeProviderBuiltIns({
    workflowBuiltIns,
    taskProviderBuiltIns
  });
  const builtIns = providerBuiltIns.workflowBuiltIns({
    git: createGitRepositoryPorts(),
    changeRequest: {
      providers: createChangeRequestProviderRegistry(changeRequestProviderFactories)
    }
  });
  assertNativeWorkflowExecutorCoverage({
    builtIns,
    patternExecutors,
    capabilityRegistry
  });

  return {
    builtIns,
    patternExecutors,
    builtInMetadata: (node: { readonly capability_id: string }) => {
      return providerBuiltIns.builtInStepRegistry.has(node.capability_id)
        ? providerBuiltIns.builtInStepRegistry.require(node.capability_id).metadata ?? {}
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

export function assertNativeWorkflowExecutorCoverage({
  builtIns,
  patternExecutors,
  capabilityRegistry = officialCapabilityRegistry
}: NativeWorkflowExecutorCoverage): void {
  const missingBuiltIns = executableCapabilityIds(
    capabilityRegistry,
    "built_ins"
  ).filter((id) => builtIns[id] === undefined);
  const missingPatterns = executableCapabilityIds(
    capabilityRegistry,
    "patterns"
  ).filter((id) => patternExecutors[id] === undefined);

  if (missingBuiltIns.length > 0 || missingPatterns.length > 0) {
    throw runtimeError(
      "Native workflow executor coverage does not match capability manifests",
      "runtime_backend_invalid",
      {
        details: {
          missing_built_ins: missingBuiltIns,
          missing_patterns: missingPatterns
        }
      }
    );
  }
}

function executableCapabilityIds(
  capabilityRegistry: CapabilityRegistry,
  kind: "built_ins" | "patterns"
): string[] {
  return [...capabilityRegistry.registrations()[kind].values()].map(
    (registration) => registration.id
  );
}
