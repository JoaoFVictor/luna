import { runtimeError } from "../runtime/errors.js";
import type { ExecutionPolicyDecision } from "./execution-policy.js";

export type WorkflowLockRelease = () => Promise<void> | void;

export type WorkflowLockManager = {
  acquire(
    resource: string,
    mode: "exclusive"
  ): Promise<WorkflowLockRelease> | WorkflowLockRelease;
};

export async function withWorkflowLocks<T>(input: {
  readonly decision: ExecutionPolicyDecision;
  readonly lockManager?: WorkflowLockManager;
  readonly runtimeContext: { readonly repository?: unknown };
  readonly run: () => Promise<T>;
}): Promise<T> {
  const releases: WorkflowLockRelease[] = [];
  let operationError: unknown;

  try {
    for (const lock of input.decision.locks) {
      const resource = workflowLockResource(lock.resource, input.runtimeContext);
      if (input.lockManager === undefined) {
        throw runtimeError("Workflow lock manager is missing", "runtime_state_invalid", {
          details: { resource, mode: lock.mode }
        });
      }

      releases.push(await input.lockManager.acquire(resource, lock.mode));
    }

    return await input.run();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    await releaseWorkflowLocks(releases, operationError);
  }
}

function workflowLockResource(
  resource: "repository",
  runtimeContext: { readonly repository?: unknown }
): string {
  if (resource !== "repository") {
    throw runtimeError("Unsupported workflow lock resource", "runtime_state_invalid", {
      details: { resource }
    });
  }

  const repositoryId = repositoryIdFrom(runtimeContext.repository);
  if (repositoryId === undefined) {
    throw runtimeError("Repository lock requires repository.id", "runtime_state_invalid", {
      details: { resource }
    });
  }

  return `repository:${repositoryId}`;
}

function repositoryIdFrom(repository: unknown): string | undefined {
  if (typeof repository !== "object" || repository === null || Array.isArray(repository)) {
    return undefined;
  }

  const id = (repository as { readonly id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

async function releaseWorkflowLocks(
  releases: WorkflowLockRelease[],
  operationError: unknown
): Promise<void> {
  let releaseError: unknown;
  for (const release of releases.reverse()) {
    try {
      await release();
    } catch (error) {
      releaseError ??= error;
    }
  }

  if (operationError === undefined && releaseError !== undefined) {
    throw releaseError;
  }
}
