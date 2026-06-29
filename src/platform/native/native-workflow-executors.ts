import path from "node:path";
import { officialCapabilityRegistry } from "../../capabilities/registry.js";
import type { CapabilityRegistry } from "../../core/capabilities/registry.js";
import type { ChangeRequestProviderFactory } from "../../capabilities/change-request/contracts.js";
import type { PullRequestReviewProviderFactory } from "../../capabilities/pull-request-review/contracts.js";
import { createProviderRegistry } from "../../core/providers/registry.js";
import type { TaskProviderBuiltIns } from "../../providers/built-ins.js";
import type { AppConfig, RepositoryConfig } from "../../core/config/schemas.js";
import { runtimeError } from "../../core/runtime/errors.js";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import type { RunHandle } from "../../core/runtime/run-handle.js";
import type { WorkflowPatternExecutor } from "../../core/workflow/execution-contracts.js";
import { RunLockManager } from "../../core/workflow/lock-manager.js";
import type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
import { createGitRepositoryPorts } from "../../runtime/git/repository-port.js";
import { cleanup as cleanupWorktree } from "../../capabilities/repository-change/worktree-cleanup.js";
import type { WorkspaceRecord } from "../../capabilities/repository-change/types.js";
import { createGitHubRepositoryWorkspacePorts } from "../../providers/github/repository-workspace.js";
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
  pullRequestReviewProviderFactories =
    nativeLunaPlatformRegistrations.pullRequestReviewProviderFactories,
  patternExecutors = nativeLunaPlatformRegistrations.patternExecutors ?? {},
  workflowBuiltIns,
  taskProviderBuiltIns,
  capabilityRegistry = officialCapabilityRegistry
}: {
  readonly app: AppConfig;
  readonly projectRoot: string;
  readonly run: RunHandle;
  readonly changeRequestProviderFactories?: readonly ChangeRequestProviderFactory[];
  readonly pullRequestReviewProviderFactories?: readonly PullRequestReviewProviderFactory[];
  readonly patternExecutors?: Readonly<Record<string, WorkflowPatternExecutor>>;
  readonly workflowBuiltIns?: NativeWorkflowBuiltIns;
  readonly taskProviderBuiltIns?: Readonly<Record<string, TaskProviderBuiltIns>>;
  readonly capabilityRegistry?: CapabilityRegistry;
}) {
  const providerBuiltIns = createNativeProviderBuiltIns({
    workflowBuiltIns,
    taskProviderBuiltIns
  });
  const lockManager = new RunLockManager({
    root: lockRoot(app, projectRoot),
    runId: run.run_id,
    timeoutMs: app.locks?.timeout_ms ?? 300_000,
    staleAfterMs: app.locks?.stale_after_ms ?? 900_000
  });
  const builtIns = providerBuiltIns.workflowBuiltIns({
    git: createGitRepositoryPorts(),
    repositoryWorkspace: createGitHubRepositoryWorkspacePorts({ lockManager }),
    changeRequest: {
      providers: createProviderRegistry(changeRequestProviderFactories, {
        label: "change request",
        unsupportedCode: "change_request_provider_unsupported"
      })
    },
    pullRequestReview: {
      providers: createProviderRegistry(pullRequestReviewProviderFactories, {
        label: "pull request review",
        unsupportedCode: "pull_request_review_provider_unsupported"
      })
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
    lockManager,
    workspaceLifecycle: createNativeWorkspaceLifecycle(app)
  };
}

function lockRoot(app: AppConfig, projectRoot: string): string {
  return path.resolve(
    projectRoot,
    app.locks?.root ?? path.join(app.artifacts.root, "locks")
  );
}

function createNativeWorkspaceLifecycle(app: AppConfig) {
  return {
    async complete({
      status,
      runtimeContext
    }: {
      readonly status: "succeeded" | "failed";
      readonly state: LunaRuntimeState;
      readonly runtimeContext: WorkflowRuntimeContext;
    }): Promise<unknown | undefined> {
      if (
        (status === "succeeded" && app.workspace.preserve_on_success) ||
        (status === "failed" && app.workspace.preserve_on_failure)
      ) {
        return undefined;
      }

      const workspace = workspaceRecordFrom(runtimeContext.workspace);
      if (workspace === undefined || workspace.preserved !== true) {
        return undefined;
      }

      const repository = repositoryConfigFrom(runtimeContext.repository);
      if (repository === undefined || runtimeContext.workspaceRoot === undefined) {
        return undefined;
      }

      return await cleanupWorktree({
        repositoryPath: repository.path,
        workspaceRoot: runtimeContext.workspaceRoot,
        workspaceRecord: workspace,
        persistedWorkspaceRecord: workspace
      });
    }
  };
}

function workspaceRecordFrom(workspace: unknown): WorkspaceRecord | undefined {
  if (typeof workspace !== "object" || workspace === null || Array.isArray(workspace)) {
    return undefined;
  }

  const candidate = workspace as Partial<WorkspaceRecord>;
  if (
    typeof candidate.run_id !== "string" ||
    typeof candidate.path !== "string" ||
    typeof candidate.preserved !== "boolean" ||
    typeof candidate.reason !== "string"
  ) {
    return undefined;
  }

  return candidate as WorkspaceRecord;
}

function repositoryConfigFrom(repository: unknown): RepositoryConfig | undefined {
  if (typeof repository !== "object" || repository === null || Array.isArray(repository)) {
    return undefined;
  }

  const candidate = repository as Partial<RepositoryConfig>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.path !== "string" ||
    typeof candidate.remote !== "string"
  ) {
    return undefined;
  }

  return candidate as RepositoryConfig;
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
