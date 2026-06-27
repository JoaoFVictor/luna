import { defineBuiltInStep } from "../built-ins/registry.js";
import type {
  BuiltInStep,
  BuiltInStepDependencies,
  BuiltInStepRunOptions
} from "../built-ins/types.js";
import type {
  LocalCommandInput,
  LocalExecArtifactPublisher,
  LocalExecCommandBuiltInPorts,
  LocalExecCommandOutput,
  LocalExecEventSink,
  LocalExecMode,
  LocalExecOperation,
  LocalExecOperationId,
  LocalExecOutputRef
} from "./contracts.js";

const DEFAULT_STATE_OUTPUT_LIMIT_BYTES = 64 * 1024;

export type LocalExecCommandBuiltInPortResolver =
  | LocalExecCommandBuiltInPorts
  | ((options: BuiltInStepRunOptions) => LocalExecCommandBuiltInPorts);

type LocalExecCommandBuiltInDependencies = BuiltInStepDependencies & {
  readonly localExec?: LocalExecCommandBuiltInPorts;
};

type LocalExecCommandInput = LocalCommandInput & {
  readonly operation_id: LocalExecOperationId;
  readonly mode: LocalExecMode;
  readonly operation: LocalExecOperation;
};

function localExecError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function commandInputFrom(input: Record<string, unknown> | undefined): LocalExecCommandInput {
  if (input === undefined) {
    throw localExecError("Local command input is required.", "local_exec_input_invalid");
  }

  if (
    input.operation_id !== "local-exec.command.read" &&
    input.operation_id !== "local-exec.command.write"
  ) {
    throw localExecError(
      "Local command operation_id is invalid.",
      "local_exec_input_invalid"
    );
  }

  if (input.mode !== "read_only" && input.mode !== "trusted_local_write") {
    throw localExecError("Local command mode is invalid.", "local_exec_input_invalid");
  }

  if (input.operation !== "read" && input.operation !== "write") {
    throw localExecError(
      "Local command operation is invalid.",
      "local_exec_input_invalid"
    );
  }

  if (typeof input.command !== "string" || input.command === "") {
    throw localExecError("Local command is required.", "local_exec_input_invalid");
  }

  if (
    !Array.isArray(input.args) ||
    input.args.some((argument) => typeof argument !== "string")
  ) {
    throw localExecError(
      "Local command args must be strings.",
      "local_exec_input_invalid"
    );
  }

  if (input.cwd !== undefined && typeof input.cwd !== "string") {
    throw localExecError("Local command cwd must be a string.", "local_exec_input_invalid");
  }

  if (
    input.timeout_ms !== undefined &&
    (typeof input.timeout_ms !== "number" ||
      !Number.isFinite(input.timeout_ms) ||
      input.timeout_ms < 1)
  ) {
    throw localExecError(
      "Local command timeout_ms must be a positive number.",
      "local_exec_input_invalid"
    );
  }

  return {
    operation_id: input.operation_id,
    mode: input.mode,
    operation: input.operation,
    command: input.command,
    args: input.args,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.timeout_ms === undefined ? {} : { timeout_ms: input.timeout_ms })
  };
}

function enforceModePolicy(input: LocalExecCommandInput): void {
  const expectedOperationId =
    input.operation === "read"
      ? "local-exec.command.read"
      : "local-exec.command.write";
  if (input.operation_id !== expectedOperationId) {
    throw localExecError(
      "Local command operation_id must match operation.",
      "local_exec_input_invalid"
    );
  }

  if (input.mode === "read_only" && input.operation !== "read") {
    throw localExecError(
      "Read-only local-exec mode rejects non-read commands.",
      "local_exec_command_rejected"
    );
  }
}

function enforceBuiltInOperation(
  name: "local-exec.command.read" | "local-exec.command.write",
  input: LocalExecCommandInput
): void {
  if (input.operation_id !== name) {
    throw localExecError(
      "Local command operation_id must match built-in name.",
      "local_exec_input_invalid"
    );
  }
}

function resolvePorts(
  resolver: LocalExecCommandBuiltInPortResolver,
  options: BuiltInStepRunOptions
): LocalExecCommandBuiltInPorts {
  return typeof resolver === "function" ? resolver(options) : resolver;
}

export function localExecPortsFromBuiltInOptions({
  dependencies = {}
}: BuiltInStepRunOptions<LocalExecCommandBuiltInDependencies>): LocalExecCommandBuiltInPorts {
  if (dependencies.localExec === undefined) {
    throw localExecError(
      "Local-exec ports are not configured for this runtime.",
      "local_exec_port_unavailable"
    );
  }

  return dependencies.localExec;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

async function outputRefFor(input: {
  readonly operationId: string;
  readonly stream: "stdout" | "stderr";
  readonly content: string;
  readonly limitBytes: number;
  readonly artifactPublisher: LocalExecArtifactPublisher;
  readonly eventSink: LocalExecEventSink;
}): Promise<LocalExecOutputRef> {
  const bytes = byteLength(input.content);

  if (bytes <= input.limitBytes) {
    return {
      inline: input.content,
      bytes
    };
  }

  const artifact = await input.artifactPublisher.publish({
    operation_id: input.operationId,
    stream: input.stream,
    content: input.content,
    media_type: "text/plain"
  });

  await input.eventSink.emit({
    type: "local-exec.output_artifact",
    operation_id: input.operationId,
    stream: input.stream,
    bytes,
    artifact
  });

  return {
    artifact,
    bytes
  };
}

export function createLocalExecCommandBuiltIn(
  ports: LocalExecCommandBuiltInPortResolver,
  name: "local-exec.command.read" | "local-exec.command.write"
): BuiltInStep<"local-exec.command.read" | "local-exec.command.write"> {
  return defineBuiltInStep({
    name,
    async run(options) {
      const { input } = options;
      const commandInput = commandInputFrom(input);
      enforceBuiltInOperation(name, commandInput);
      enforceModePolicy(commandInput);
      const resolvedPorts = resolvePorts(ports, options);

      const result = await resolvedPorts.commandPort.run({
        command: commandInput.command,
        args: commandInput.args,
        ...(commandInput.cwd === undefined ? {} : { cwd: commandInput.cwd }),
        ...(commandInput.timeout_ms === undefined
          ? {}
          : { timeout_ms: commandInput.timeout_ms })
      });
      const limitBytes =
        resolvedPorts.stateOutputLimitBytes ?? DEFAULT_STATE_OUTPUT_LIMIT_BYTES;

      const output: LocalExecCommandOutput = {
        operation_id: commandInput.operation_id,
        command: commandInput.command,
        args: commandInput.args,
        ...(commandInput.cwd === undefined ? {} : { cwd: commandInput.cwd }),
        exit_code: result.exit_code,
        stdout: await outputRefFor({
          operationId: commandInput.operation_id,
          stream: "stdout",
          content: result.stdout,
          limitBytes,
          artifactPublisher: resolvedPorts.artifactPublisher,
          eventSink: resolvedPorts.eventSink
        }),
        stderr: await outputRefFor({
          operationId: commandInput.operation_id,
          stream: "stderr",
          content: result.stderr,
          limitBytes,
          artifactPublisher: resolvedPorts.artifactPublisher,
          eventSink: resolvedPorts.eventSink
        }),
        duration_ms: result.duration_ms,
        timed_out: result.timed_out
      };

      return output;
    }
  });
}
