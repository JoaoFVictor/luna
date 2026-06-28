export type LocalExecMode = "read_only" | "trusted_local_write";

export type LocalExecOperation = "read" | "write";

export type LocalExecOperationId =
  | "local-exec.command.read"
  | "local-exec.command.write";

export type LocalCommandInput = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeout_ms?: number;
};

export type LocalCommandResult = {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly duration_ms: number;
  readonly timed_out: boolean;
};

export type LocalCommandPort = {
  run(input: LocalCommandInput): LocalCommandResult | Promise<LocalCommandResult>;
};

export type LocalExecArtifactRef = {
  readonly id: string;
  readonly uri: string;
};

export type LocalExecArtifactPublisher = {
  publish(input: {
    readonly operation_id: string;
    readonly stream: "stdout" | "stderr";
    readonly content: string;
    readonly media_type: "text/plain";
  }): LocalExecArtifactRef | Promise<LocalExecArtifactRef>;
};

export type LocalExecEvent = {
  readonly type: "local-exec.output_artifact";
  readonly operation_id: string;
  readonly stream: "stdout" | "stderr";
  readonly bytes: number;
  readonly artifact: LocalExecArtifactRef;
};

export type LocalExecEventSink = {
  emit(event: LocalExecEvent): void | Promise<void>;
};

export type LocalExecCommandBuiltInPorts = {
  readonly commandPort: LocalCommandPort;
  readonly artifactPublisher: LocalExecArtifactPublisher;
  readonly eventSink: LocalExecEventSink;
  readonly stateOutputLimitBytes?: number;
};

export type LocalExecOutputRef =
  | {
      readonly inline: string;
      readonly bytes: number;
    }
  | {
      readonly artifact: LocalExecArtifactRef;
      readonly bytes: number;
    };

export type LocalExecCommandOutput = {
  readonly operation_id: LocalExecOperationId;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly exit_code: number;
  readonly stdout: LocalExecOutputRef;
  readonly stderr: LocalExecOutputRef;
  readonly duration_ms: number;
  readonly timed_out: boolean;
};
