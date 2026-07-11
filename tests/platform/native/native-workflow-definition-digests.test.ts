import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import {
  LUNA_RUNTIME_STATE_SCHEMA_VERSION,
  createInitialRuntimeState
} from "../../../src/core/runtime/state.js";
import type {
  ResumeWorkflowInput,
  RunWorkflowInput,
  WorkflowRunResult
} from "../../../src/core/workflow/execution-contracts.js";
import type { WorkflowRuntimeFactory } from "../../../src/core/workflow/runner-port.js";
import {
  resumeNativeWorkflowTarget,
  runNativeWorkflowTarget
} from "../../../src/platform/native/native-workflow-runner.js";
import {
  nativeLunaPlatformRegistrations,
  type NativeLunaPlatformRegistrations
} from "../../../src/platform/native/native-platform-registrations.js";

const temporaryDirectories: string[] = [];

async function writeProject(): Promise<{
  projectRoot: string;
  configRoot: string;
}> {
  const projectRoot = await mkdtemp(
    path.join(tmpdir(), "luna-native-agent-digests-")
  );
  temporaryDirectories.push(projectRoot);
  const configRoot = path.join(projectRoot, "config");
  const workflowDirectory = path.join(projectRoot, "workflows", "agent-run");
  const agentDirectory = path.join(projectRoot, "agents", "reviewer");
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(workflowDirectory, { recursive: true }),
    mkdir(agentDirectory, { recursive: true })
  ]);
  await Promise.all([
    writeFile(
      path.join(configRoot, "app.yaml"),
      [
        "workspace:",
        "  strategy: git_worktree",
        "  root: .runs/workspaces",
        "  preserve_on_success: false",
        "  preserve_on_failure: false",
        "artifacts:",
        "  root: .runs",
        "workflow_runtime:",
        "  id: capture",
        "  options: {}",
        "agent_runtime:",
        "  id: capture-agent",
        "  options: {}",
        ""
      ].join("\n")
    ),
    writeFile(path.join(configRoot, "repositories.yaml"), "repositories: []\n"),
    writeFile(
      path.join(configRoot, "models.yaml"),
      [
        "model_profiles:",
        "  default:",
        "    model: test/model",
        "    reasoning_effort: low",
        ""
      ].join("\n")
    ),
    writeFile(
      path.join(workflowDirectory, "workflow.yaml"),
      [
        "id: agent-run",
        "type: workflow",
        "mode: read_only",
        "input_schema: input.schema.json",
        "output_schema: output.schema.json",
        "capabilities:",
        "  - agents",
        "nodes:",
        "  - id: review",
        "    type: agent",
        "    agent: reviewer",
        "    output_schema: output.schema.json",
        ""
      ].join("\n")
    ),
    writeFile(
      path.join(workflowDirectory, "input.schema.json"),
      '{"type":"object"}\n'
    ),
    writeFile(
      path.join(workflowDirectory, "output.schema.json"),
      '{"type":"object"}\n'
    ),
    writeFile(
      path.join(agentDirectory, "agent.yaml"),
      [
        "id: reviewer",
        "description: Reviews changes",
        "model_profile: default",
        "mode: read_only",
        "instructions_file: instructions.md",
        "output_schema: output.schema.json",
        ""
      ].join("\n")
    ),
    writeFile(
      path.join(agentDirectory, "instructions.md"),
      "Review carefully.\n"
    ),
    writeFile(
      path.join(agentDirectory, "output.schema.json"),
      '{"type":"object"}\n'
    )
  ]);

  return { projectRoot, configRoot };
}

function captureAgentRuntime(): AgentRuntimePort {
  return {
    describe: () => ({
      id: "capture-agent",
      display_name: "Capture agent",
      supported_tool_protocols: [],
      supported_runtime_requirements: []
    }),
    validate() {},
    async runAgent() {
      return { output: {} };
    }
  };
}

function successfulResult(input: RunWorkflowInput): WorkflowRunResult {
  const state = createInitialRuntimeState({
    invocation: input.invocation,
    config: input.config,
    run: input.run,
    workflow: {
      id: input.workflow.id,
      mode: input.workflow.mode
    }
  });
  return {
    status: "succeeded",
    output: {},
    state: { ...state, run_status: "succeeded" }
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("native workflow agent definition digests", () => {
  it("passes resolved agent digests to both run and resume", async () => {
    const { projectRoot, configRoot } = await writeProject();
    let runInput: RunWorkflowInput | undefined;
    let resumeInput: ResumeWorkflowInput | undefined;
    const workflowRuntimeFactory: WorkflowRuntimeFactory<
      RunWorkflowInput,
      ResumeWorkflowInput,
      WorkflowRunResult
    > = {
      id: "capture",
      create: () => ({
        async run(input) {
          runInput = input;
          return successfulResult(input);
        },
        async resume(input) {
          resumeInput = input;
          if (runInput === undefined) {
            throw new Error("run input was not captured");
          }
          return successfulResult(runInput);
        }
      })
    };
    const platform: NativeLunaPlatformRegistrations = {
      ...nativeLunaPlatformRegistrations,
      workflowRuntimeFactories: { capture: workflowRuntimeFactory },
      agentRuntimeFactories: {
        "capture-agent": {
          id: "capture-agent",
          create: captureAgentRuntime
        }
      }
    };
    const invocation = {
      version: "2026-06" as const,
      source: "test",
      event: "agent_run"
    };
    const target = { type: "workflow" as const, id: "agent-run" };

    await runNativeWorkflowTarget(
      { projectRoot, configRoot, invocation, target },
      { platform }
    );
    if (runInput === undefined) {
      throw new Error("run input was not captured");
    }
    const reference = "agents/reviewer/agent.yaml";
    const runRevision = runInput.workflow.external_definition_digests[reference];
    expect(runRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(runRevision).not.toBe("sha256:unresolved");

    await runInput.backends.checkpoints.save({
      thread_id: "thread-1",
      checkpoint_id: "checkpoint-1",
      state_schema_version: LUNA_RUNTIME_STATE_SCHEMA_VERSION,
      state: { state_schema_version: LUNA_RUNTIME_STATE_SCHEMA_VERSION },
      metadata: {
        resume_context: {
          invocation,
          config: {},
          run: runInput.run
        }
      }
    });
    await resumeNativeWorkflowTarget(
      {
        projectRoot,
        configRoot,
        target,
        thread_id: "thread-1",
        checkpoint_id: "checkpoint-1",
        interrupt_id: "interrupt-1",
        decision: { approved: true }
      },
      { platform }
    );

    expect(resumeInput).toBeDefined();
    expect(
      resumeInput?.workflow.external_definition_digests[reference]
    ).toBe(runRevision);
    expect(
      Object.values(resumeInput?.workflow.external_definition_digests ?? {})
    ).not.toContain("sha256:unresolved");
  });
});
