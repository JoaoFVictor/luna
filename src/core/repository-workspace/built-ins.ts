import { defineBuiltInStep } from "../built-ins/registry.js";
import {
  repositoryWorkspaceCaptureMetadata
} from "../built-ins/metadata.js";
import type {
  BuiltInStep,
  BuiltInStepRunOptions
} from "../built-ins/types.js";
import type {
  RepositoryWorkspaceBuiltInPorts,
  RepositoryWorkspaceCaptureInput,
  RepositoryWorkspaceCaptureResult,
  RepositoryWorkspaceManagerRecord,
  RepositoryWorkspaceRecord,
  RepositoryWorkspaceReleaseReason
} from "./contracts.js";

export type RepositoryWorkspaceBuiltInPortResolver =
  | RepositoryWorkspaceBuiltInPorts
  | ((options: BuiltInStepRunOptions) => RepositoryWorkspaceBuiltInPorts);

type CaptureBuiltInInput = {
  readonly operation_id: "repository-workspace.capture";
  readonly repository_id: string;
  readonly lock_timeout_ms?: number;
};

function repositoryWorkspaceError(
  message: string,
  code: string
): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function resolvePorts(
  resolver: RepositoryWorkspaceBuiltInPortResolver,
  options: BuiltInStepRunOptions
): RepositoryWorkspaceBuiltInPorts {
  return typeof resolver === "function" ? resolver(options) : resolver;
}

export function repositoryWorkspacePortsFromBuiltInOptions({
  dependencies = {}
}: BuiltInStepRunOptions): RepositoryWorkspaceBuiltInPorts {
  const { repositoryWorkspace } = dependencies;

  if (repositoryWorkspace === undefined) {
    throw repositoryWorkspaceError(
      "Repository workspace ports are not configured for this runtime.",
      "repository_workspace_port_unavailable"
    );
  }

  return repositoryWorkspace;
}

function runIdFrom(state: { run?: unknown }): string {
  const run = state.run as { run_id?: unknown } | undefined;
  if (typeof run?.run_id !== "string" || run.run_id === "") {
    throw repositoryWorkspaceError(
      "Repository workspace capture requires state.run.run_id.",
      "repository_workspace_input_invalid"
    );
  }

  return run.run_id;
}

function captureInputFrom(
  input: Record<string, unknown> | undefined,
  state: { run?: unknown; repository?: unknown }
): CaptureBuiltInInput {
  if (
    input?.operation_id !== undefined &&
    input.operation_id !== "repository-workspace.capture"
  ) {
    throw repositoryWorkspaceError(
      "Repository workspace operation_id is invalid.",
      "repository_workspace_input_invalid"
    );
  }

  const repositoryId =
    typeof input?.repository_id === "string" && input.repository_id !== ""
      ? input.repository_id
      : repositoryIdFromState(state);

  if (
    input?.lock_timeout_ms !== undefined &&
    (typeof input.lock_timeout_ms !== "number" ||
      !Number.isSafeInteger(input.lock_timeout_ms) ||
      input.lock_timeout_ms < 1)
  ) {
    throw repositoryWorkspaceError(
      "Repository workspace lock_timeout_ms must be a positive integer.",
      "repository_workspace_input_invalid"
    );
  }

  return {
    operation_id: "repository-workspace.capture",
    repository_id: repositoryId,
    ...(input?.lock_timeout_ms === undefined
      ? {}
      : { lock_timeout_ms: input.lock_timeout_ms })
  };
}

function repositoryIdFromState(state: { repository?: unknown }): string {
  const repository = state.repository as { id?: unknown } | undefined;
  if (typeof repository?.id !== "string" || repository.id === "") {
    throw repositoryWorkspaceError(
      "Repository workspace capture requires repository_id.",
      "repository_workspace_input_invalid"
    );
  }

  return repository.id;
}

function existingWorkspaceFrom(
  state: { workspace?: unknown },
  input: CaptureBuiltInInput,
  runId: string
): RepositoryWorkspaceRecord | undefined {
  const candidate = state.workspace as Partial<RepositoryWorkspaceRecord> | undefined;
  if (candidate === undefined) {
    return undefined;
  }

  if (candidate.operation_id !== "repository-workspace.capture") {
    return undefined;
  }

  if (
    candidate.run_id !== runId ||
    candidate.repository_id !== input.repository_id
  ) {
    throw repositoryWorkspaceError(
      "Repository workspace capture conflicts with the run workspace.",
      "repository_workspace_capture_conflict"
    );
  }

  if (!isRepositoryWorkspaceRecord(candidate)) {
    throw repositoryWorkspaceError(
      "Repository workspace capture state is invalid.",
      "repository_workspace_capture_conflict"
    );
  }

  return candidate;
}

function isRepositoryWorkspaceRecord(
  candidate: Partial<RepositoryWorkspaceRecord>
): candidate is RepositoryWorkspaceRecord {
  return (
    candidate.operation_id === "repository-workspace.capture" &&
    typeof candidate.run_id === "string" &&
    typeof candidate.repository_id === "string" &&
    typeof candidate.workspace_id === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.preserved === "boolean" &&
    typeof candidate.reason === "string" &&
    typeof candidate.lifecycle === "string" &&
    typeof candidate.captured_at === "string"
  );
}

function releaseReasonFromError(error: unknown): RepositoryWorkspaceReleaseReason {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code === "string") {
    if (code.includes("timeout") || code.includes("timed_out")) {
      return "timeout";
    }
    if (code.includes("cancel")) {
      return "cancellation";
    }
  }

  return "failure";
}

function managerInput(
  input: CaptureBuiltInInput,
  runId: string,
  state: BuiltInStepRunOptions["state"]
): RepositoryWorkspaceCaptureInput {
  return {
    operation_id: "repository-workspace.capture",
    run_id: runId,
    repository_id: input.repository_id,
    context: {
      invocation: state.invocation,
      repository: state.repository,
      workspaceRoot: state.workspaceRoot
    },
    ...(input.lock_timeout_ms === undefined
      ? {}
      : { lock_timeout_ms: input.lock_timeout_ms })
  };
}

function captureResult(input: {
  readonly workspace: RepositoryWorkspaceRecord;
  readonly adopted: boolean;
  readonly token: string;
  readonly acquiredAt: string;
  readonly releaseReason: RepositoryWorkspaceReleaseReason;
}): RepositoryWorkspaceCaptureResult {
  return {
    ...input.workspace,
    adopted: input.adopted,
    workspace: input.workspace,
    lock: {
      repository_id: input.workspace.repository_id,
      token: input.token,
      lifecycle: "released",
      acquired_at: input.acquiredAt,
      release_reason: input.releaseReason
    }
  };
}

function normalizeWorkspaceRecord(
  record: RepositoryWorkspaceManagerRecord,
  input: RepositoryWorkspaceCaptureInput
): RepositoryWorkspaceRecord {
  return {
    ...record,
    operation_id: "repository-workspace.capture",
    run_id: input.run_id,
    repository_id: input.repository_id
  };
}

export function createRepositoryWorkspaceCaptureBuiltIn(
  ports: RepositoryWorkspaceBuiltInPortResolver
): BuiltInStep<"repository-workspace.capture"> {
  return defineBuiltInStep({
    name: "repository-workspace.capture",
    metadata: repositoryWorkspaceCaptureMetadata,
    async run(options) {
      const { state, input } = options;
      const captureInput = captureInputFrom(input, state);
      const runId = runIdFrom(state);
      const existingWorkspace = existingWorkspaceFrom(
        state,
        captureInput,
        runId
      );
      const resolvedPorts = resolvePorts(ports, options);

      if (existingWorkspace !== undefined) {
        await resolvedPorts.eventSink.emit({
          type: "repository-workspace.capture_adopted",
          operation_id: "repository-workspace.capture",
          run_id: runId,
          repository_id: captureInput.repository_id,
          workspace_id: existingWorkspace.workspace_id,
          lifecycle: existingWorkspace.lifecycle,
          path: existingWorkspace.path
        });

        return captureResult({
          workspace: existingWorkspace,
          adopted: true,
          token: "adopted",
          acquiredAt: existingWorkspace.captured_at,
          releaseReason: "success"
        });
      }

      const lock = await resolvedPorts.lockManager.acquire({
        operation_id: "repository-workspace.capture",
        run_id: runId,
        repository_id: captureInput.repository_id,
        ...(captureInput.lock_timeout_ms === undefined
          ? {}
          : { timeout_ms: captureInput.lock_timeout_ms })
      });
      let releaseReason: RepositoryWorkspaceReleaseReason = "success";

      try {
        const capture = managerInput(captureInput, runId, state);
        const workspace = normalizeWorkspaceRecord(
          await resolvedPorts.manager.capture(capture),
          capture
        );

        await resolvedPorts.eventSink.emit({
          type: "repository-workspace.captured",
          operation_id: "repository-workspace.capture",
          run_id: runId,
          repository_id: captureInput.repository_id,
          workspace_id: workspace.workspace_id,
          lifecycle: workspace.lifecycle,
          path: workspace.path
        });

        return captureResult({
          workspace,
          adopted: false,
          token: lock.token,
          acquiredAt: lock.acquired_at,
          releaseReason
        });
      } catch (error) {
        releaseReason = releaseReasonFromError(error);
        throw error;
      } finally {
        await resolvedPorts.lockManager.release({
          token: lock.token,
          operation_id: "repository-workspace.capture",
          run_id: runId,
          repository_id: captureInput.repository_id,
          reason: releaseReason
        });
        await resolvedPorts.eventSink.emit({
          type: "repository-workspace.lock_released",
          operation_id: "repository-workspace.capture",
          run_id: runId,
          repository_id: captureInput.repository_id,
          reason: releaseReason
        });
      }
    }
  });
}
