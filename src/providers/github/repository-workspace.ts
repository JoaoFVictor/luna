import type { RepositoryWorkspaceBuiltInPorts } from "../../capabilities/repository-workspace/contracts.js";
import type { RepositoryConfig } from "../../core/config/schemas.js";
import type { Invocation } from "../../core/router/invocation.js";
import type {
  WorkflowLockManager,
  WorkflowLockRelease
} from "../../core/workflow/runner-locks.js";
import { prepare as prepareGitHubWorktree } from "./worktree-manager.js";

type RepositoryWorkspaceContext = {
  readonly invocation: Invocation;
  readonly repository: RepositoryConfig;
  readonly workspaceRoot: string;
};

function providerWorkspaceError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function workspaceContextFrom(context: unknown): RepositoryWorkspaceContext {
  if (typeof context !== "object" || context === null) {
    throw providerWorkspaceError(
      "Repository workspace context is required",
      "repository_workspace_context_invalid"
    );
  }

  const candidate = context as {
    invocation?: unknown;
    repository?: unknown;
    workspaceRoot?: unknown;
  };

  if (
    candidate.invocation === undefined ||
    candidate.repository === undefined ||
    typeof candidate.workspaceRoot !== "string" ||
    candidate.workspaceRoot === ""
  ) {
    throw providerWorkspaceError(
      "Repository workspace context is incomplete",
      "repository_workspace_context_invalid"
    );
  }

  return {
    invocation: candidate.invocation as Invocation,
    repository: candidate.repository as RepositoryConfig,
    workspaceRoot: candidate.workspaceRoot
  };
}

export function createGitHubRepositoryWorkspacePorts({
  lockManager,
  now = () => new Date()
}: {
  readonly lockManager: WorkflowLockManager;
  readonly now?: () => Date;
}): RepositoryWorkspaceBuiltInPorts {
  const releases = new Map<string, WorkflowLockRelease>();
  let nextToken = 0;

  return {
    manager: {
      async capture(input) {
        const context = workspaceContextFrom(input.context);
        const workspace = await prepareGitHubWorktree({
          invocation: context.invocation,
          repository: context.repository,
          workspaceRoot: context.workspaceRoot,
          runId: input.run_id
        });

        return {
          ...workspace,
          workspace_id: `${input.repository_id}:${input.run_id}`,
          lifecycle: "active",
          captured_at: now().toISOString()
        };
      }
    },
    lockManager: {
      async acquire(input) {
        const release = await lockManager.acquire(
          `repository:${input.repository_id}`,
          "exclusive"
        );
        const token = `repository-workspace-${input.run_id}-${++nextToken}`;
        releases.set(token, release);

        return {
          token,
          repository_id: input.repository_id,
          acquired_at: now().toISOString()
        };
      },
      async release(input) {
        const release = releases.get(input.token);
        if (release === undefined) {
          throw providerWorkspaceError(
            "Repository workspace lock token is unknown",
            "workspace_lock_release_failed"
          );
        }

        await release();
        releases.delete(input.token);
      }
    },
    eventSink: {
      emit() {
        return undefined;
      }
    }
  };
}
