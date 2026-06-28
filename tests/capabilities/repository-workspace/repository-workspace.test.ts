import { describe, expect, it, vi } from "vitest";
import {
  createRepositoryWorkspaceCaptureBuiltIn
} from "../../../src/capabilities/repository-workspace/built-ins.js";
import type {
  RepositoryWorkspaceEventSink,
  RepositoryWorkspaceManagerPort,
  RepositoryWorkspaceManagerRecord
} from "../../../src/capabilities/repository-workspace/contracts.js";

const state = {
  invocation: {},
  run: { run_id: "run-1" },
  repository: { id: "repo-1", path: "/repo" },
  steps: {}
};

describe("repository-workspace capability", () => {
  it("captures a workspace once per run and records lifecycle events", async () => {
    const manager: RepositoryWorkspaceManagerPort = {
      capture: vi.fn(async (): Promise<RepositoryWorkspaceManagerRecord> => ({
        run_id: "run-1",
        workspace_id: "workspace-1",
        path: "/repo/workspaces/run-1",
        preserved: true,
        reason: "active",
        lifecycle: "active",
        captured_at: "2026-06-26T10:00:00.000Z"
      }))
    };
    const lock = lockManager();
    const events = eventSink();
    const builtIn = createRepositoryWorkspaceCaptureBuiltIn({
      manager,
      lockManager: lock,
      eventSink: events
    });

    await expect(
      builtIn.run({
        state,
        input: {
          operation_id: "repository-workspace.capture",
          repository_id: "repo-1",
          lock_timeout_ms: 5000
        }
      })
    ).resolves.toMatchObject({
      operation_id: "repository-workspace.capture",
      run_id: "run-1",
      repository_id: "repo-1",
      workspace: {
        workspace_id: "workspace-1",
        path: "/repo/workspaces/run-1",
        lifecycle: "active"
      },
      lock: {
        repository_id: "repo-1",
        lifecycle: "released",
        release_reason: "success"
      }
    });
    expect(lock.acquire).toHaveBeenCalledWith({
      operation_id: "repository-workspace.capture",
      run_id: "run-1",
      repository_id: "repo-1",
      timeout_ms: 5000
    });
    expect(manager.capture).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "repository-workspace.captured",
        run_id: "run-1",
        repository_id: "repo-1"
      })
    );
  });

  it("adopts a previous capture for the same run without reacquiring locks", async () => {
    const manager: RepositoryWorkspaceManagerPort = {
      capture: vi.fn()
    };
    const lock = lockManager();
    const events = eventSink();
    const builtIn = createRepositoryWorkspaceCaptureBuiltIn({
      manager,
      lockManager: lock,
      eventSink: events
    });

    await expect(
      builtIn.run({
        state: {
          ...state,
          workspace: {
            operation_id: "repository-workspace.capture",
            run_id: "run-1",
            repository_id: "repo-1",
            workspace_id: "workspace-1",
            path: "/repo/workspaces/run-1",
            preserved: true,
            reason: "active",
            lifecycle: "active",
            captured_at: "2026-06-26T10:00:00.000Z"
          }
        },
        input: {
          operation_id: "repository-workspace.capture",
          repository_id: "repo-1"
        }
      })
    ).resolves.toMatchObject({
      adopted: true,
      workspace: {
        workspace_id: "workspace-1",
        lifecycle: "active"
      }
    });
    expect(lock.acquire).not.toHaveBeenCalled();
    expect(manager.capture).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "repository-workspace.capture_adopted" })
    );
  });

  it("fails on conflicting capture attempts for the same run", async () => {
    const builtIn = createRepositoryWorkspaceCaptureBuiltIn({
      manager: { capture: vi.fn() },
      lockManager: lockManager(),
      eventSink: eventSink()
    });

    await expect(
      builtIn.run({
        state: {
          ...state,
          workspace: {
            operation_id: "repository-workspace.capture",
            run_id: "run-1",
            repository_id: "other-repo",
            workspace_id: "workspace-1",
            path: "/repo/workspaces/run-1",
            preserved: true,
            reason: "active",
            lifecycle: "active",
            captured_at: "2026-06-26T10:00:00.000Z"
          }
        },
        input: {
          operation_id: "repository-workspace.capture",
          repository_id: "repo-1"
        }
      })
    ).rejects.toMatchObject({ code: "repository_workspace_capture_conflict" });
  });

  it("releases repository locks when capture fails", async () => {
    const lock = lockManager();
    const builtIn = createRepositoryWorkspaceCaptureBuiltIn({
      manager: { capture: vi.fn(asyncReject("boom")) },
      lockManager: lock,
      eventSink: eventSink()
    });

    const run = builtIn.run({
      state,
      input: {
        operation_id: "repository-workspace.capture",
        repository_id: "repo-1"
      }
    });

    await expect(run).rejects.toThrow();
    expect(lock.release).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "lock-token",
        reason: "failure"
      })
    );
  });

  it("surfaces lock conflicts before capture starts", async () => {
    const manager: RepositoryWorkspaceManagerPort = {
      capture: vi.fn()
    };
    const lock = lockManager();
    vi.mocked(lock.acquire).mockRejectedValueOnce(
      Object.assign(new Error("busy"), { code: "workspace_lock_conflict" })
    );
    const builtIn = createRepositoryWorkspaceCaptureBuiltIn({
      manager,
      lockManager: lock,
      eventSink: eventSink()
    });

    await expect(
      builtIn.run({
        state,
        input: {
          operation_id: "repository-workspace.capture",
          repository_id: "repo-1"
        }
      })
    ).rejects.toMatchObject({ code: "workspace_lock_conflict" });
    expect(manager.capture).not.toHaveBeenCalled();
  });

});

function lockManager() {
  return {
    acquire: vi.fn(async () => ({
      token: "lock-token",
      repository_id: "repo-1",
      acquired_at: "2026-06-26T09:59:59.000Z"
    })),
    release: vi.fn(async () => undefined)
  };
}

function eventSink(): RepositoryWorkspaceEventSink {
  return {
    emit: vi.fn(async () => undefined)
  };
}

function asyncReject(message: string, code?: string) {
  return async () => {
    throw Object.assign(new Error(message), code === undefined ? {} : { code });
  };
}
