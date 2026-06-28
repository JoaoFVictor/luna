export type RepositoryWorkspaceOperationId = "repository-workspace.capture";

export type RepositoryWorkspaceLifecycle =
  | "active"
  | "released"
  | "failed"
  | "cancelled"
  | "timed_out";

export type RepositoryWorkspaceReleaseReason =
  | "success"
  | "failure"
  | "cancellation"
  | "timeout";

export type RepositoryWorkspaceCaptureInput = {
  readonly operation_id: RepositoryWorkspaceOperationId;
  readonly run_id: string;
  readonly repository_id: string;
  readonly lock_timeout_ms?: number;
  readonly context?: unknown;
};

export type RepositoryWorkspaceRecord = {
  readonly operation_id: RepositoryWorkspaceOperationId;
  readonly run_id: string;
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly path: string;
  readonly preserved: boolean;
  readonly reason: string;
  readonly lifecycle: RepositoryWorkspaceLifecycle;
  readonly captured_at: string;
  readonly artifact?: RepositoryWorkspaceArtifactRef;
};

export type RepositoryWorkspaceManagerRecord = Omit<
  RepositoryWorkspaceRecord,
  "operation_id" | "run_id" | "repository_id"
> & {
  readonly operation_id?: RepositoryWorkspaceOperationId;
  readonly run_id?: string;
  readonly repository_id?: string;
};

export type RepositoryWorkspaceCaptureResult = RepositoryWorkspaceRecord & {
  readonly adopted: boolean;
  readonly workspace: RepositoryWorkspaceRecord;
  readonly lock: RepositoryWorkspaceLockLifecycleRecord;
};

export type RepositoryWorkspaceManagerPort = {
  capture(
    input: RepositoryWorkspaceCaptureInput
  ): RepositoryWorkspaceManagerRecord | Promise<RepositoryWorkspaceManagerRecord>;
};

export type RepositoryWorkspaceLock = {
  readonly token: string;
  readonly repository_id: string;
  readonly acquired_at: string;
};

export type RepositoryWorkspaceLockManagerPort = {
  acquire(input: {
    readonly operation_id: RepositoryWorkspaceOperationId;
    readonly run_id: string;
    readonly repository_id: string;
    readonly timeout_ms?: number;
  }): RepositoryWorkspaceLock | Promise<RepositoryWorkspaceLock>;
  release(input: {
    readonly token: string;
    readonly operation_id: RepositoryWorkspaceOperationId;
    readonly run_id: string;
    readonly repository_id: string;
    readonly reason: RepositoryWorkspaceReleaseReason;
  }): void | Promise<void>;
};

export type RepositoryWorkspaceArtifactRef = {
  readonly id: string;
  readonly uri: string;
};

export type RepositoryWorkspaceLockLifecycleRecord = {
  readonly repository_id: string;
  readonly token: string;
  readonly lifecycle: "acquired" | "released";
  readonly acquired_at: string;
  readonly release_reason?: RepositoryWorkspaceReleaseReason;
};

export type RepositoryWorkspaceEvent =
  | {
      readonly type: "repository-workspace.captured";
      readonly operation_id: RepositoryWorkspaceOperationId;
      readonly run_id: string;
      readonly repository_id: string;
      readonly workspace_id: string;
      readonly lifecycle: RepositoryWorkspaceLifecycle;
      readonly path: string;
    }
  | {
      readonly type: "repository-workspace.capture_adopted";
      readonly operation_id: RepositoryWorkspaceOperationId;
      readonly run_id: string;
      readonly repository_id: string;
      readonly workspace_id: string;
      readonly lifecycle: RepositoryWorkspaceLifecycle;
      readonly path: string;
    }
  | {
      readonly type: "repository-workspace.lock_released";
      readonly operation_id: RepositoryWorkspaceOperationId;
      readonly run_id: string;
      readonly repository_id: string;
      readonly reason: RepositoryWorkspaceReleaseReason;
    };

export type RepositoryWorkspaceEventSink = {
  emit(event: RepositoryWorkspaceEvent): void | Promise<void>;
};

export type RepositoryWorkspaceBuiltInPorts = {
  readonly manager: RepositoryWorkspaceManagerPort;
  readonly lockManager: RepositoryWorkspaceLockManagerPort;
  readonly eventSink: RepositoryWorkspaceEventSink;
};
