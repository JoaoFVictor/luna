import { cleanup as defaultCleanupWorktree } from "./git-worktree-manager.js";
import { lifecycleEvidenceFromSchedulerState } from "./implementation-lifecycle.js";
import { workspaceLifecycleDecision } from "./workspace-lifecycle.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { SchedulerLockManager } from "./workflow-scheduler.js";
import type {
  AppConfig,
  RepositoryConfig,
  RuntimeConfigState,
  WorkspaceRecord
} from "./types.js";
import { configuredWorkflowError } from "./configured-workflow-errors.js";

export async function finalizeFailureWorkspace({
  artifactStore,
  workspaceRecord,
  persistedWorkspaceRecord,
  repository,
  workspaceConfig,
  cleanupWorktree
}: {
  artifactStore: ArtifactStore;
  workspaceRecord?: WorkspaceRecord;
  persistedWorkspaceRecord?: WorkspaceRecord;
  repository?: RepositoryConfig;
  workspaceConfig: AppConfig["workspace"];
  cleanupWorktree: typeof defaultCleanupWorktree;
}): Promise<WorkspaceRecord | undefined> {
  if (workspaceRecord === undefined) {
    return undefined;
  }

  let finalWorkspace = workspaceRecord;

  if (
    workspaceRecord.reason === "success_cleanup" ||
    workspaceRecord.reason === "success_cleanup_failed" ||
    workspaceRecord.reason === "success_preserved" ||
    workspaceRecord.reason === "failure_cleanup_failed" ||
    workspaceRecord.reason === "failure_preserved"
  ) {
    finalWorkspace = workspaceRecord;
  } else if (workspaceConfig.preserve_on_failure) {
    finalWorkspace = {
      ...workspaceRecord,
      preserved: true,
      reason: "failure_preserved"
    };
  } else if (repository !== undefined) {
    try {
      finalWorkspace = await cleanupWorktree({
        repositoryPath: repository.path,
        workspaceRoot: workspaceConfig.root,
        workspaceRecord,
        persistedWorkspaceRecord
      });
    } catch {
      finalWorkspace = {
        ...workspaceRecord,
        preserved: true,
        reason: "failure_cleanup_failed"
      };
    }
  }

  await artifactStore.writeJson("workspace.json", finalWorkspace);
  return finalWorkspace;
}

export async function finalizeSuccessWorkspace({
  artifactStore,
  workspaceRecord,
  persistedWorkspaceRecord,
  repository,
  workspaceConfig,
  workflowMode,
  implementationConfig,
  lifecycleEvidence,
  cleanupWorktree
}: {
  artifactStore: ArtifactStore;
  workspaceRecord?: WorkspaceRecord;
  persistedWorkspaceRecord?: WorkspaceRecord;
  repository?: RepositoryConfig;
  workspaceConfig: AppConfig["workspace"];
  workflowMode: "git_managed_read_only" | "git_managed_write";
  implementationConfig?: RuntimeConfigState["implementation"];
  lifecycleEvidence: ReturnType<typeof lifecycleEvidenceFromSchedulerState>;
  cleanupWorktree: typeof defaultCleanupWorktree;
}): Promise<WorkspaceRecord | undefined> {
  if (workspaceRecord === undefined) {
    return undefined;
  }

  if (workflowMode === "git_managed_write") {
    return await finalizeWriteSuccessWorkspace({
      artifactStore,
      workspaceRecord,
      persistedWorkspaceRecord,
      repository,
      workspaceConfig,
      implementationConfig,
      lifecycleEvidence,
      cleanupWorktree
    });
  }

  let finalWorkspace: WorkspaceRecord;

  if (!workspaceConfig.preserve_on_success) {
    if (repository === undefined) {
      finalWorkspace = workspaceRecord;
    } else {
      try {
        finalWorkspace = await cleanupWorktree({
          repositoryPath: repository.path,
          workspaceRoot: workspaceConfig.root,
          workspaceRecord,
          persistedWorkspaceRecord
        });
      } catch (cause) {
        const failedWorkspace = {
          ...workspaceRecord,
          preserved: true,
          reason: "success_cleanup_failed"
        };
        await artifactStore.writeJson("workspace.json", failedWorkspace);
        const error = configuredWorkflowError(
          "Successful review workspace cleanup failed",
          "success_cleanup_failed",
          cause
        );
        (error as Error & { workspaceRecord?: WorkspaceRecord }).workspaceRecord =
          failedWorkspace;
        throw error;
      }
    }
  } else {
    finalWorkspace = {
      ...workspaceRecord,
      preserved: true,
      reason: "success_preserved"
    };
  }

  await artifactStore.writeJson("workspace.json", finalWorkspace);
  return finalWorkspace;
}

export function cleanupMayRemoveWorktree({
  workspaceRecord,
  repository,
  workspaceConfig,
  workflowMode,
  implementationConfig,
  lifecycleEvidence,
  success
}: {
  workspaceRecord?: WorkspaceRecord;
  repository?: RepositoryConfig;
  workspaceConfig: AppConfig["workspace"];
  workflowMode: "git_managed_read_only" | "git_managed_write";
  implementationConfig?: RuntimeConfigState["implementation"];
  lifecycleEvidence: ReturnType<typeof lifecycleEvidenceFromSchedulerState>;
  success: boolean;
}): boolean {
  if (workspaceRecord === undefined || repository === undefined) {
    return false;
  }

  if (!success) {
    return !workspaceConfig.preserve_on_failure;
  }

  if (workflowMode === "git_managed_read_only") {
    return !workspaceConfig.preserve_on_success;
  }

  return !workspaceLifecycleDecision(lifecycleEvidence, {
    commitEnabled: implementationConfig?.commit.enabled ?? false,
    pushEnabled: implementationConfig?.push.enabled ?? false,
    changeRequestEnabled: implementationConfig?.change_request.enabled ?? false
  }).preserve;
}

export async function withRepositoryCleanupLock<T>({
  lockManager,
  repository,
  locked,
  run
}: {
  lockManager?: SchedulerLockManager;
  repository?: RepositoryConfig;
  locked: boolean;
  run: () => Promise<T>;
}): Promise<T> {
  if (!locked || repository === undefined) {
    return await run();
  }

  if (lockManager === undefined) {
    throw configuredWorkflowError(
      "Lock manager is missing",
      "lock_manager_missing"
    );
  }

  const release = await lockManager.acquire(
    `repository:${repository.id}`,
    "exclusive"
  );
  let operationError: unknown;

  try {
    return await run();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await release();
    } catch (error) {
      if (
        operationError !== undefined &&
        ((typeof operationError === "object" && operationError !== null) ||
          typeof operationError === "function")
      ) {
        Object.defineProperty(operationError, "releaseErrors", {
          configurable: true,
          value: [error]
        });
      } else {
        throw configuredWorkflowError(
          "Failed to release workflow lock",
          "lock_release_failed",
          error
        );
      }
    }
  }
}

async function finalizeWriteSuccessWorkspace({
  artifactStore,
  workspaceRecord,
  persistedWorkspaceRecord,
  repository,
  workspaceConfig,
  implementationConfig,
  lifecycleEvidence,
  cleanupWorktree
}: {
  artifactStore: ArtifactStore;
  workspaceRecord: WorkspaceRecord;
  persistedWorkspaceRecord?: WorkspaceRecord;
  repository?: RepositoryConfig;
  workspaceConfig: AppConfig["workspace"];
  implementationConfig?: RuntimeConfigState["implementation"];
  lifecycleEvidence: ReturnType<typeof lifecycleEvidenceFromSchedulerState>;
  cleanupWorktree: typeof defaultCleanupWorktree;
}): Promise<WorkspaceRecord> {
  const lifecycle = workspaceLifecycleDecision(lifecycleEvidence, {
    commitEnabled: implementationConfig?.commit.enabled ?? false,
    pushEnabled: implementationConfig?.push.enabled ?? false,
    changeRequestEnabled: implementationConfig?.change_request.enabled ?? false
  });

  if (lifecycle.preserve) {
    const finalWorkspace = {
      ...workspaceRecord,
      preserved: true,
      reason: lifecycle.reason
    };
    await artifactStore.writeJson("workspace.json", finalWorkspace);
    return finalWorkspace;
  }

  if (repository === undefined) {
    await artifactStore.writeJson("workspace.json", workspaceRecord);
    return workspaceRecord;
  }

  try {
    const finalWorkspace = await cleanupWorktree({
      repositoryPath: repository.path,
      workspaceRoot: workspaceConfig.root,
      workspaceRecord,
      persistedWorkspaceRecord
    });
    await artifactStore.writeJson("workspace.json", finalWorkspace);
    return finalWorkspace;
  } catch (cause) {
    const failedWorkspace = {
      ...workspaceRecord,
      preserved: true,
      reason: "success_cleanup_failed"
    };
    await artifactStore.writeJson("workspace.json", failedWorkspace);
    const error = configuredWorkflowError(
      "Successful implementation workspace cleanup failed",
      "success_cleanup_failed",
      cause
    );
    (error as Error & { workspaceRecord?: WorkspaceRecord }).workspaceRecord =
      failedWorkspace;
    throw error;
  }
}
