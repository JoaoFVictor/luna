import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  LocalExecCommandBuiltInPorts,
  LocalExecEvent
} from "../local-exec/contracts.js";
import { safeJoin } from "../security/path.js";
import { defaultProcessRunner } from "../validation/runner.js";

type LocalExecLog = {
  info(message: string, attributes?: Record<string, unknown>): void;
};

export type NodeLocalExecPortsOptions = {
  readonly projectRoot: string;
  readonly runId: string;
  readonly log?: LocalExecLog;
  readonly stateOutputLimitBytes?: number;
};

function safeSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);

  return segment === "" || segment === "." || segment === ".."
    ? "artifact"
    : segment;
}

export function createNodeLocalExecPorts({
  projectRoot,
  runId,
  log,
  stateOutputLimitBytes
}: NodeLocalExecPortsOptions): LocalExecCommandBuiltInPorts {
  let artifactCounter = 0;
  const safeRunId = safeSegment(runId);

  return {
    stateOutputLimitBytes,
    commandPort: {
      async run(input) {
        const result = await defaultProcessRunner({
          cmd: input.command,
          args: input.args,
          cwd: input.cwd ?? projectRoot,
          timeoutMs: input.timeout_ms
        });

        return {
          exit_code: result.exitCode ?? 1,
          stdout: result.stdout,
          stderr: result.stderr,
          duration_ms: result.durationMs,
          timed_out: result.timedOut
        };
      }
    },
    artifactPublisher: {
      async publish({ operation_id, stream, content }) {
        artifactCounter += 1;
        const artifactId = [
          safeSegment(operation_id),
          safeSegment(stream),
          String(artifactCounter).padStart(4, "0")
        ].join("-");
        const artifactPath = await safeJoin(path.join(projectRoot, ".luna"), [
          "local-exec-artifacts",
          safeRunId,
          `${artifactId}.txt`
        ]);

        await mkdir(path.dirname(artifactPath), { recursive: true });
        await writeFile(artifactPath, content, "utf8");

        return {
          id: artifactId,
          uri: `artifact://${safeRunId}/local-exec/${artifactId}.txt`
        };
      }
    },
    eventSink: {
      emit(event: LocalExecEvent) {
        log?.info("local-exec.output_artifact", {
          operation_id: event.operation_id,
          stream: event.stream,
          bytes: event.bytes,
          artifact_id: event.artifact.id,
          artifact_uri: event.artifact.uri
        });
      }
    }
  };
}
