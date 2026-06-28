import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import {
  defaultBuiltInCatalog,
  builtInStepNames as providerBuiltInStepNames,
  runBuiltInStep as runProviderBuiltInStep
} from "../../../src/platform/native/native-built-ins.js";
import { manifest } from "../../../src/capabilities/local-exec/manifest.js";
import {
  createLocalExecCommandBuiltIn
} from "../../../src/core/local-exec/built-ins.js";
import type { BuiltInStepDependencies } from "../../../src/core/built-ins/types.js";
import type {
  LocalCommandPort,
  LocalExecArtifactPublisher,
  LocalExecEventSink
} from "../../../src/core/local-exec/contracts.js";

const state = {
  invocation: {},
  run: { run_id: "run-1" },
  workflow: { id: "workflow-1", mode: "read_only" },
  steps: {}
};

describe("local-exec capability", () => {
  it("registers a provider-agnostic command built-in with side-effect policy", () => {
    const registry = createCapabilityRegistry([manifest]);

    const localExec = registry.get("local-exec");
    const readBuiltIn = localExec.built_ins?.["local-exec.command.read"];
    const writeBuiltIn = localExec.built_ins?.["local-exec.command.write"];
    const readPolicy = localExec.policies?.["local-exec.command_read_policy"];
    const writePolicy = localExec.policies?.["local-exec.command_write_policy"];

    expect(readBuiltIn).toMatchObject({
      id: "local-exec.command.read",
      required_ports: [
        "local-exec.command_port",
        "local-exec.artifact_publisher",
        "local-exec.event_sink"
      ],
      side_effect_policy: "local-exec.command_read_policy"
    });
    expect(writeBuiltIn).toMatchObject({
      id: "local-exec.command.write",
      side_effect_policy: "local-exec.command_write_policy"
    });
    expect(readPolicy).toMatchObject({
      id: "local-exec.command_read_policy",
      side_effect_semantics: "read",
      side_effect_operation_ids: ["local-exec.command.read"],
      retry_semantics: "replay_safe"
    });
    expect(writePolicy).toMatchObject({
      id: "local-exec.command_write_policy",
      side_effect_semantics: "write",
      side_effect_operation_ids: ["local-exec.command.write"],
      idempotency_scope: "attempt",
      retry_semantics: "retry_requires_adoption"
    });
    expect(writePolicy?.config_schema).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["operation_id"])
    });
    expect(readBuiltIn?.input_schema).toMatchObject({
      properties: {
        operation_id: { enum: ["local-exec.command.read"] },
        operation: { enum: ["read"] }
      }
    });
    expect(writeBuiltIn?.input_schema).toMatchObject({
      properties: {
        operation_id: { enum: ["local-exec.command.write"] },
        operation: { enum: ["write"] }
      }
    });
  });

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

  it("executes through the command port in trusted-write mode", async () => {
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
    ).resolves.toEqual({
      operation_id: "local-exec.command.write",
      command: "npm",
      args: ["test"],
      cwd: "/repo",
      exit_code: 0,
      stdout: { inline: "ok", bytes: 2 },
      stderr: { inline: "", bytes: 0 },
      duration_ms: 12,
      timed_out: false
    });
    expect(commandPort.run).toHaveBeenCalledWith({
      command: "npm",
      args: ["test"],
      cwd: "/repo",
      timeout_ms: 1000
    });
  });

  it("rejects operation ids that do not match the declared operation", async () => {
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
          mode: "trusted_local_write",
          operation_id: "local-exec.command.read",
          operation: "write",
          command: "npm",
          args: ["test"]
        }
      })
    ).rejects.toMatchObject({ code: "local_exec_input_invalid" });
    expect(commandPort.run).not.toHaveBeenCalled();
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

  it("creates built-ins with manifest-matching names", () => {
    const ports = {
      commandPort: { run: vi.fn() },
      artifactPublisher: artifactPublisher(),
      eventSink: eventSink()
    };

    expect(createLocalExecCommandBuiltIn(ports, "local-exec.command.read").name).toBe(
      "local-exec.command.read"
    );
    expect(createLocalExecCommandBuiltIn(ports, "local-exec.command.write").name).toBe(
      "local-exec.command.write"
    );
  });

  it("executes manifest-matching local-exec built-ins through the default catalog", async () => {
    const commandPort: LocalCommandPort = {
      run: vi.fn(async () => ({
        exit_code: 0,
        stdout: "catalog",
        stderr: "",
        duration_ms: 3,
        timed_out: false
      }))
    };
    const dependencies = {
      localExec: {
        commandPort,
        artifactPublisher: artifactPublisher(),
        eventSink: eventSink()
      }
    } satisfies BuiltInStepDependencies;

    await expect(
      defaultBuiltInCatalog.runBuiltInStep({
        uses: "local-exec.command.read",
        state,
        dependencies,
        input: {
          mode: "read_only",
          operation_id: "local-exec.command.read",
          operation: "read",
          command: "git",
          args: ["status", "--short"]
        }
      })
    ).resolves.toMatchObject({
      operation_id: "local-exec.command.read",
      stdout: { inline: "catalog", bytes: 7 }
    });
    expect(defaultBuiltInCatalog.names).toEqual(
      expect.arrayContaining([
        "local-exec.command.read",
        "local-exec.command.write"
      ])
    );
    expect(commandPort.run).toHaveBeenCalledWith({
      command: "git",
      args: ["status", "--short"]
    });
  });

  it("executes local-exec built-ins through the provider runtime catalog", async () => {
    const commandPort: LocalCommandPort = {
      run: vi.fn(async () => ({
        exit_code: 0,
        stdout: "provider",
        stderr: "",
        duration_ms: 4,
        timed_out: false
      }))
    };

    await expect(
      runProviderBuiltInStep({
        uses: "local-exec.command.read",
        state,
        dependencies: {
          localExec: {
            commandPort,
            artifactPublisher: artifactPublisher(),
            eventSink: eventSink()
          }
        },
        input: {
          mode: "read_only",
          operation_id: "local-exec.command.read",
          operation: "read",
          command: "pwd",
          args: []
        }
      })
    ).resolves.toMatchObject({
      operation_id: "local-exec.command.read",
      stdout: { inline: "provider", bytes: 8 }
    });
    expect(providerBuiltInStepNames).toEqual(
      expect.arrayContaining([
        "local-exec.command.read",
        "local-exec.command.write"
      ])
    );
  });

  it("keeps local-exec leaf files free of provider, Git, shell, and runtime leaks", async () => {
    const repositoryRoot = process.cwd();
    const files = [
      "src/core/local-exec/contracts.ts",
      "src/capabilities/local-exec/manifest.ts",
      "src/core/local-exec/built-ins.ts"
    ];
    const forbiddenPatterns = [
      /node:child_process|child_process/,
      /src\/core\/git|src\/core\/write-mode|simple-git/,
      /change-request|changeRequest|ChangeRequest/,
      /src\/providers|src\/core\/providers|@octokit|jira\.js|node-fetch/,
      /langgraph|LangGraph|@langchain/
    ];

    for (const file of files) {
      const source = await readFile(path.join(repositoryRoot, file), "utf8");

      for (const forbiddenPattern of forbiddenPatterns) {
        expect(source, `${file} contains ${forbiddenPattern}`).not.toMatch(
          forbiddenPattern
        );
      }
    }
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
