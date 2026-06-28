import { describe, expect, it, vi } from "vitest";
import {
  createLocalExecCommandBuiltIn
} from "../../../src/capabilities/local-exec/built-ins.js";
import type {
  LocalCommandPort,
  LocalExecArtifactPublisher,
  LocalExecEventSink
} from "../../../src/capabilities/local-exec/contracts.js";

const state = {
  invocation: {},
  run: { run_id: "run-1" },
  workflow: { id: "workflow-1", mode: "read_only" },
  steps: {}
};

describe("local-exec capability", () => {
  it("rejects non-read commands in read-only mode before using the command port", async () => {
    const commandPort: LocalCommandPort = {
      run: vi.fn()
    };
    const builtIn = createLocalExecCommandBuiltIn(
      {
        commandPort,
        artifactPublisher: artifactPublisher(),
        eventSink: eventSink()
      },
      "local-exec.command.write"
    );

    await expect(
      builtIn.run({
        state,
        input: {
          mode: "read_only",
          operation_id: "local-exec.command.write",
          operation: "write",
          command: "npm",
          args: ["test"]
        }
      })
    ).rejects.toMatchObject({ code: "local_exec_command_rejected" });
    expect(commandPort.run).not.toHaveBeenCalled();
  });

  it("executes through the command port in trusted local write mode", async () => {
    const commandPort: LocalCommandPort = {
      run: vi.fn(async () => ({
        exit_code: 0,
        stdout: "ok",
        stderr: "",
        duration_ms: 12,
        timed_out: false
      }))
    };
    const builtIn = createLocalExecCommandBuiltIn(
      {
        commandPort,
        artifactPublisher: artifactPublisher(),
        eventSink: eventSink()
      },
      "local-exec.command.write"
    );

    await expect(
      builtIn.run({
        state,
        input: {
          mode: "trusted_local_write",
          operation_id: "local-exec.command.write",
          operation: "write",
          command: "npm",
          args: ["test"],
          cwd: "/repo",
          timeout_ms: 1000
        }
      })
    ).resolves.toMatchObject({
      operation_id: "local-exec.command.write",
      command: "npm",
      args: ["test"],
      cwd: "/repo",
      exit_code: 0,
      stdout: { inline: "ok", bytes: 2 },
      timed_out: false
    });
    expect(commandPort.run).toHaveBeenCalledWith({
      command: "npm",
      args: ["test"],
      cwd: "/repo",
      timeout_ms: 1000
    });
  });

  it("rejects operation ids that do not match the invoked built-in", async () => {
    const commandPort: LocalCommandPort = {
      run: vi.fn()
    };
    const builtIn = createLocalExecCommandBuiltIn(
      {
        commandPort,
        artifactPublisher: artifactPublisher(),
        eventSink: eventSink()
      },
      "local-exec.command.read"
    );

    await expect(
      builtIn.run({
        state,
        input: {
          mode: "trusted_local_write",
          operation_id: "local-exec.command.write",
          operation: "write",
          command: "npm",
          args: ["test"]
        }
      })
    ).rejects.toMatchObject({ code: "local_exec_input_invalid" });
    expect(commandPort.run).not.toHaveBeenCalled();
  });

  it("publishes oversized command output as artifacts and events", async () => {
    const artifactPublisher = {
      publish: vi.fn<LocalExecArtifactPublisher["publish"]>(
        async ({ stream }) => ({
          id: `artifact-${stream}`,
          uri: `artifact://${stream}`
        })
      )
    };
    const eventSink = {
      emit: vi.fn<LocalExecEventSink["emit"]>(async () => undefined)
    };
    const builtIn = createLocalExecCommandBuiltIn(
      {
        commandPort: {
          run: vi.fn(async () => ({
            exit_code: 1,
            stdout: "123456",
            stderr: "abcdef",
            duration_ms: 5,
            timed_out: false
          }))
        },
        artifactPublisher,
        eventSink,
        stateOutputLimitBytes: 5
      },
      "local-exec.command.read"
    );

    await expect(
      builtIn.run({
        state,
        input: {
          mode: "trusted_local_write",
          operation_id: "local-exec.command.read",
          operation: "read",
          command: "node",
          args: ["--version"]
        }
      })
    ).resolves.toMatchObject({
      stdout: { artifact: { id: "artifact-stdout", uri: "artifact://stdout" }, bytes: 6 },
      stderr: { artifact: { id: "artifact-stderr", uri: "artifact://stderr" }, bytes: 6 }
    });
    expect(artifactPublisher.publish).toHaveBeenCalledTimes(2);
    expect(eventSink.emit).toHaveBeenCalledTimes(2);
    expect(eventSink.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "local-exec.output_artifact",
        stream: "stdout",
        bytes: 6
      })
    );
  });

});

function artifactPublisher(): LocalExecArtifactPublisher {
  return {
    publish: vi.fn(async ({ stream }) => ({
      id: `artifact-${stream}`,
      uri: `artifact://${stream}`
    }))
  };
}

function eventSink(): LocalExecEventSink {
  return {
    emit: vi.fn(async () => undefined)
  };
}
