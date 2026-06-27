import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { manifest } from "../../../src/capabilities/repository-workspace/manifest.js";
import {
  createRepositoryWorkspaceCaptureBuiltIn
} from "../../../src/core/repository-workspace/built-ins.js";
import type {
  RepositoryWorkspaceEventSink,
  RepositoryWorkspaceManagerPort,
  RepositoryWorkspaceManagerRecord
} from "../../../src/core/repository-workspace/contracts.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { defaultBuiltInCatalog } from "../../../src/core/built-ins/catalog.js";
import {
  builtInStepNames as providerBuiltInStepNames,
  runBuiltInStep as runProviderBuiltInStep
} from "../../../src/platform/native/native-built-ins.js";

const state = {
  invocation: {},
  run: { run_id: "run-1" },
  workflow: { id: "workflow-1", mode: "trusted_local_write" },
  repository: { id: "repo-1", path: "/repo" },
  steps: {}
};

describe("repository-workspace capability", () => {
  it("declares explicit capture, lock, lifecycle, and event contracts", () => {
    const registry = createCapabilityRegistry([manifest]);
    const workspace = registry.get("repository-workspace");

    expect(workspace.built_ins?.["repository-workspace.capture"]).toMatchObject({
      id: "repository-workspace.capture",
      required_ports: [
        "repository-workspace.manager",
        "repository-workspace.lock_manager",
        "repository-workspace.event_sink"
      ],
      side_effect_policy: "repository-workspace.capture_policy"
    });
    expect(workspace.ports?.["repository-workspace.lock_manager"]).toMatchObject({
      id: "repository-workspace.lock_manager",
      lifecycle: ["validate", "open", "close"],
      error_codes: ["workspace_lock_conflict", "workspace_lock_release_failed"]
    });
    expect(workspace.policies?.["repository-workspace.capture_policy"]).toMatchObject({
      side_effect_semantics: "write",
      side_effect_operation_ids: ["repository-workspace.capture"],
      idempotency_scope: "run",
      retry_semantics: "retry_requires_adoption"
    });
  });

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

  it("derives repository capture input from state for simple YAML nodes", async () => {
    const manager: RepositoryWorkspaceManagerPort = {
      capture: vi.fn(async (): Promise<RepositoryWorkspaceManagerRecord> => ({
        workspace_id: "workspace-1",
        path: "/repo/workspaces/run-1",
        preserved: true,
        reason: "active",
        lifecycle: "active",
        captured_at: "2026-06-26T10:00:00.000Z"
      }))
    };
    const lock = lockManager();
    const builtIn = createRepositoryWorkspaceCaptureBuiltIn({
      manager,
      lockManager: lock,
      eventSink: eventSink()
    });

    await expect(
      builtIn.run({
        state
      })
    ).resolves.toMatchObject({
      operation_id: "repository-workspace.capture",
      run_id: "run-1",
      repository_id: "repo-1",
      adopted: false
    });
    expect(manager.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        operation_id: "repository-workspace.capture",
        run_id: "run-1",
        repository_id: "repo-1"
      })
    );
    expect(lock.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
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

  it("releases repository locks for success, failure, cancellation, and timeout", async () => {
    const outcomes = [
      { name: "success", release: "success", capture: asyncCapture("active") },
      { name: "failure", release: "failure", capture: asyncReject("boom") },
      {
        name: "cancellation",
        release: "cancellation",
        capture: asyncReject("cancelled", "workflow_cancelled")
      },
      {
        name: "timeout",
        release: "timeout",
        capture: asyncReject("timed out", "workflow_timeout")
      }
    ] as const;

    for (const outcome of outcomes) {
      const lock = lockManager();
      const builtIn = createRepositoryWorkspaceCaptureBuiltIn({
        manager: { capture: vi.fn(outcome.capture) },
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

      if (outcome.name === "success") {
        await expect(run).resolves.toMatchObject({ adopted: false });
      } else {
        await expect(run).rejects.toThrow();
      }
      expect(lock.release).toHaveBeenCalledWith(
        expect.objectContaining({
          token: "lock-token",
          reason: outcome.release
        })
      );
    }
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

  it("executes repository-workspace capture through core and provider catalogs", async () => {
    const dependencies = {
      repositoryWorkspace: {
        manager: {
          capture: vi.fn(async (): Promise<RepositoryWorkspaceManagerRecord> => ({
            workspace_id: "workspace-1",
            path: "/repo/workspaces/run-1",
            preserved: true,
            reason: "active",
            lifecycle: "active",
            captured_at: "2026-06-26T10:00:00.000Z"
          }))
        },
        lockManager: lockManager(),
        eventSink: eventSink()
      }
    };
    const input = {
      operation_id: "repository-workspace.capture",
      repository_id: "repo-1"
    } as const;

    await expect(
      defaultBuiltInCatalog.runBuiltInStep({
        uses: "repository-workspace.capture",
        state,
        dependencies,
        input
      })
    ).resolves.toMatchObject({
      operation_id: "repository-workspace.capture",
      run_id: "run-1",
      adopted: false
    });
    await expect(
      runProviderBuiltInStep({
        uses: "repository-workspace.capture",
        state,
        dependencies,
        input
      })
    ).resolves.toMatchObject({
      operation_id: "repository-workspace.capture",
      run_id: "run-1",
      adopted: false
    });
    expect(defaultBuiltInCatalog.names).toContain("repository-workspace.capture");
    expect(providerBuiltInStepNames).toContain("repository-workspace.capture");
  });

  it("keeps repository-workspace leaf files free of provider, Git, and change-request leaks", async () => {
    const repositoryRoot = process.cwd();
    const files = [
      "src/core/repository-workspace/contracts.ts",
      "src/capabilities/repository-workspace/manifest.ts",
      "src/core/repository-workspace/built-ins.ts"
    ];
    const forbidden = [
      "github",
      "jira",
      "plane",
      "git.",
      "git ",
      "change-request",
      "pull_request",
      "commit_sha",
      "remote",
      "branch"
    ];

    for (const file of files) {
      const source = await readFile(path.join(repositoryRoot, file), "utf8");
      for (const term of forbidden) {
        expect(source.toLowerCase(), `${file} leaked ${term}`).not.toContain(term);
      }
    }
  });

  it("keeps generic workflow runner free of provider workspace defaults", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/runtime/langgraph/workflow-runner.ts"),
      "utf8"
    );

    expect(source).not.toContain("../providers/github");
    expect(source).not.toContain("defaultPrepareWorktree");
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

function asyncCapture(lifecycle: "active") {
  return async () => ({
    run_id: "run-1",
    workspace_id: "workspace-1",
    path: "/repo/workspaces/run-1",
    preserved: true,
    reason: lifecycle,
    lifecycle,
    captured_at: "2026-06-26T10:00:00.000Z"
  });
}

function asyncReject(message: string, code?: string) {
  return async () => {
    throw Object.assign(new Error(message), code === undefined ? {} : { code });
  };
}
