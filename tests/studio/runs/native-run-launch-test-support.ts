import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, vi } from "vitest";
import type { NativeWorkflowRunInput } from "../../../src/runtime/composition/target-executor.js";
import type { WorkflowNodeLifecycleEvent } from "../../../src/core/workflow/events.js";
import { assertCheckpointJsonValue } from "../../../src/core/runtime/json.js";
import {
  failNode,
  startNodeAttempt,
  succeedNode
} from "../../../src/core/runtime/lifecycle.js";
import { createInitialRuntimeState } from "../../../src/core/runtime/state.js";
import { loadNativeRunContext } from "../../../src/platform/native/native-run-context.js";
import {
  nativeLunaPlatformRegistrations,
  type NativeLunaPlatformRegistrations
} from "../../../src/platform/native/native-platform-registrations.js";
import { MemoryStudioRunConfirmations } from "../../../src/studio/adapters/memory/run-confirmations.js";
import { NativeStudioRunPlanResolver } from "../../../src/studio/adapters/native/run-plan-resolver.js";
import type { NativeStudioRunDispatchPayload } from "../../../src/studio/adapters/native/run-snapshot-contracts.js";
import type {
  StudioRunDispatchCommand,
  StudioRunDispatcherPort
} from "../../../src/studio/application/runs/launch-ports.js";
import { StudioRunLaunchService } from "../../../src/studio/application/runs/launch-service.js";
import type { RunLedgerPort } from "../../../src/studio/application/runs/ports.js";
import type {
  StudioRunLaunchContext,
  StudioRunPlanRequest
} from "../../../src/studio/contracts/run-launch.js";

export const BASE_TIME = Date.parse("2026-07-11T12:00:00.000Z");

const temporaryDirectories: string[] = [];

type NativeDispatchCommand = StudioRunDispatchCommand<
  NativeStudioRunDispatchPayload
>;

export type NativeFixture = {
  readonly root: string;
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly queueRoot: string;
  readonly databasePath: string;
  readonly workflowPath: string;
  readonly agentInstructionsPath: string;
  readonly runtimeConfigPath: string;
  readonly routingPath: string;
  readonly workflowSource: string;
  readonly agentInstructions: string;
  readonly runtimeConfig: string;
  readonly routingSource: string;
};

export const request: StudioRunPlanRequest = {
  workflow_id: "pinned-workflow",
  invocation: {
    version: "2026-06",
    source: "studio",
    event: "manual",
    target: { type: "workflow", id: "pinned-workflow" },
    payload: { prompt: "Inspect the immutable definition" }
  },
  config: { message: "accepted configuration" },
  input_provenance: { kind: "invocation" }
};

export const launchContext: StudioRunLaunchContext = {
  actor_id: "local-user",
  actor_binding: "server-owned-session-binding",
  request_id: "request-native-launch-test"
};

export const executeRequest = (confirmationToken: string) => ({
  confirmation_token: confirmationToken,
  idempotency_key: "native-launch-idempotency-key",
  confirmation: {
    kind: "local_explicit" as const,
    real_run_confirmed: true as const,
    listed_effects_confirmed: true as const
  }
});

export async function writeFixture(): Promise<NativeFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-native-launch-"));
  temporaryDirectories.push(root);
  const projectRoot = path.join(root, "project");
  const configRoot = path.join(root, "config");
  const workflowDirectory = path.join(
    projectRoot,
    "workflows",
    "pinned-workflow"
  );
  const agentDirectory = path.join(projectRoot, "agents", "pinned-agent");
  await Promise.all([
    mkdir(workflowDirectory, { recursive: true }),
    mkdir(agentDirectory, { recursive: true }),
    mkdir(configRoot, { recursive: true })
  ]);

  const workflowSource = [
    "id: pinned-workflow",
    "type: workflow",
    "mode: read_only",
    "input_schema: input.schema.json",
    "output_schema: output.schema.json",
    "config:",
    "  file: pinned-workflow.yaml",
    "  schema: config.schema.json",
    "capabilities:",
    "  - agents",
    "requires:",
    "  repository: false",
    "execution:",
    "  max_concurrency: 1",
    "nodes:",
    "  - id: analyze",
    "    type: agent",
    "    agent: pinned-agent",
    "    output_schema: output.schema.json",
    "    input:",
    "      invocation:",
    "        expression: $.invocation",
    ""
  ].join("\n");
  const agentInstructions = "Use only the pinned workflow definition.\n";
  const runtimeConfig = "message: file default that must not override the request\n";
  const routingSource = [
    "type: router",
    'version: "2026-06"',
    "rules:",
    "  - id: explicit-target",
    "    when:",
    '      expression: "$exists($.invocation.target)"',
    "    target: $.invocation.target",
    ""
  ].join("\n");
  const objectSchema = JSON.stringify({ type: "object" });
  const configSchema = JSON.stringify({
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: { message: { type: "string", minLength: 1 } }
  });

  const workflowPath = path.join(workflowDirectory, "workflow.yaml");
  const agentInstructionsPath = path.join(agentDirectory, "instructions.md");
  const runtimeConfigPath = path.join(configRoot, "pinned-workflow.yaml");
  const routingPath = path.join(configRoot, "routing.yaml");
  await Promise.all([
    writeFile(workflowPath, workflowSource),
    writeFile(path.join(workflowDirectory, "input.schema.json"), objectSchema),
    writeFile(path.join(workflowDirectory, "output.schema.json"), objectSchema),
    writeFile(path.join(workflowDirectory, "config.schema.json"), configSchema),
    writeFile(
      path.join(agentDirectory, "agent.yaml"),
      [
        "id: pinned-agent",
        "description: Agent used to verify immutable Studio dispatch.",
        "model_profile: fast",
        "mode: read_only",
        "instructions_file: instructions.md",
        "output_schema: output.schema.json",
        ""
      ].join("\n")
    ),
    writeFile(agentInstructionsPath, agentInstructions),
    writeFile(path.join(agentDirectory, "output.schema.json"), objectSchema),
    writeFile(
      path.join(configRoot, "app.yaml"),
      [
        "workspace:",
        "  strategy: git_worktree",
        "  root: .runs/workspaces",
        "  preserve_on_success: true",
        "  preserve_on_failure: true",
        "artifacts:",
        "  root: .runs",
        "workflow_runtime:",
        "  id: langgraph",
        "  options: {}",
        "agent_runtime:",
        "  id: pi",
        "  options: {}",
        ""
      ].join("\n")
    ),
    writeFile(path.join(configRoot, "repositories.yaml"), "repositories: []\n"),
    writeFile(
      path.join(configRoot, "models.yaml"),
      [
        "model_profiles:",
        "  fast:",
        "    model: test/test-model",
        "    reasoning_effort: low",
        ""
      ].join("\n")
    ),
    writeFile(runtimeConfigPath, runtimeConfig),
    writeFile(routingPath, routingSource)
  ]);

  return {
    root,
    projectRoot,
    configRoot,
    queueRoot: path.join(root, "run-dispatch"),
    databasePath: path.join(root, "runs.sqlite"),
    workflowPath,
    agentInstructionsPath,
    runtimeConfigPath,
    routingPath,
    workflowSource,
    agentInstructions,
    runtimeConfig,
    routingSource
  };
}

function resolver(
  fixture: NativeFixture,
  platform: NativeLunaPlatformRegistrations
): NativeStudioRunPlanResolver {
  return new NativeStudioRunPlanResolver({
    projectRoot: fixture.projectRoot,
    configRoot: fixture.configRoot,
    platform
  });
}

export function launchService(
  fixture: NativeFixture,
  dispatcher: StudioRunDispatcherPort<NativeStudioRunDispatchPayload>,
  options: {
    readonly now?: () => number;
    readonly createPlanId?: () => string;
    readonly platform?: NativeLunaPlatformRegistrations;
  } = {}
): StudioRunLaunchService<NativeStudioRunDispatchPayload> {
  const now = options.now ?? (() => BASE_TIME);
  return new StudioRunLaunchService({
    resolver: resolver(
      fixture,
      options.platform ?? nativeLunaPlatformRegistrations
    ),
    confirmations: new MemoryStudioRunConfirmations({ now }),
    dispatcher,
    now,
    createPlanId: options.createPlanId ?? (() => `rp_${"p".repeat(32)}`)
  });
}

export async function captureCommand(
  fixture: NativeFixture,
  options: { readonly platform?: NativeLunaPlatformRegistrations } = {}
): Promise<{
  readonly command: NativeDispatchCommand;
  readonly confirmationToken: string;
}> {
  let captured: NativeDispatchCommand | undefined;
  const service = launchService(fixture, {
    dispatch: async (command) => {
      captured = command;
      return {
        accepted: true,
        dispatch_status: "queued",
        run_id: "captured-native-run",
        plan_id: command.planId,
        execution_snapshot_hash: command.snapshot.execution_snapshot_hash,
        accepted_at: command.requestedAt
      };
    }
  }, options);
  const plan = await service.plan(request, launchContext);
  await service.execute(
    plan.plan_id,
    executeRequest(plan.confirmation_token),
    launchContext
  );
  if (captured === undefined) {
    throw new Error("Run command was not captured");
  }
  return { command: captured, confirmationToken: plan.confirmation_token };
}

export async function successfulResult(
  input: NativeWorkflowRunInput,
  options: {
    readonly beforeCompiledBarrier?: () => Promise<void>;
    readonly afterStart?: () => Promise<void>;
    readonly afterSuccessProjection?: () => Promise<void>;
    readonly duplicateStartObservation?: boolean;
  } = {}
) {
  if (input.run === undefined) {
    throw new Error("Native Studio test runner requires a preallocated run");
  }
  const context = await loadNativeRunContext(input, {
    platform: nativeLunaPlatformRegistrations
  });
  await options.beforeCompiledBarrier?.();
  await input.onCompiledWorkflow?.(context.nativeWorkflow.compiled);
  const invocation = input.invocation;
  const config = input.workflowConfig ?? {};
  assertCheckpointJsonValue(invocation);
  assertCheckpointJsonValue(config);
  let state = createInitialRuntimeState({
    invocation,
    config,
    run: input.run,
    workflow: {
      id: context.nativeWorkflow.compiled.workflow_id,
      mode: context.workflow.mode
    }
  });
  state = startNodeAttempt(state, "analyze", 1);
  const startedEvent = {
    type: "node.started",
    node_id: "analyze",
    attempt: 1,
    occurred_at: new Date().toISOString(),
    artifact_count: 0,
    interrupt_count: 0
  } as const;
  await projectNodeLifecycle(input, startedEvent);
  await options.afterStart?.();
  state = succeedNode(state, "analyze");
  await projectNodeLifecycle(input, {
    type: "node.succeeded",
    node_id: "analyze",
    attempt: 1,
    occurred_at: new Date().toISOString(),
    artifact_count: 0,
    interrupt_count: 0
  });
  if (options.duplicateStartObservation === true) {
    await projectNodeLifecycle(input, startedEvent);
  }
  await options.afterSuccessProjection?.();
  const succeededState = { ...state, run_status: "succeeded" as const };
  await input.onSucceededState?.(succeededState);
  return {
    status: "succeeded" as const,
    output: {},
    state: succeededState
  };
}

export async function failedResult(
  input: NativeWorkflowRunInput,
  cause: Error
): Promise<never> {
  if (input.run === undefined) {
    throw new Error("Native Studio test runner requires a preallocated run");
  }
  const context = await loadNativeRunContext(input, {
    platform: nativeLunaPlatformRegistrations
  });
  await input.onCompiledWorkflow?.(context.nativeWorkflow.compiled);
  const invocation = input.invocation;
  const config = input.workflowConfig ?? {};
  assertCheckpointJsonValue(invocation);
  assertCheckpointJsonValue(config);
  let state = createInitialRuntimeState({
    invocation,
    config,
    run: input.run,
    workflow: {
      id: context.nativeWorkflow.compiled.workflow_id,
      mode: context.workflow.mode
    }
  });
  state = startNodeAttempt(state, "analyze", 1);
  await projectNodeLifecycle(input, {
    type: "node.started",
    node_id: "analyze",
    attempt: 1,
    occurred_at: new Date().toISOString(),
    artifact_count: 0,
    interrupt_count: 0
  });
  state = failNode(state, "analyze");
  await projectNodeLifecycle(input, {
    type: "node.failed",
    node_id: "analyze",
    attempt: 1,
    occurred_at: new Date().toISOString(),
    artifact_count: 0,
    interrupt_count: 0
  });
  input.onFailedState?.({ ...state, run_status: "failed" });
  throw cause;
}

export async function projectNodeLifecycle(
  input: NativeWorkflowRunInput,
  event: WorkflowNodeLifecycleEvent
): Promise<void> {
  try {
    await input.onLifecycleEvent?.(event);
  } catch (cause) {
    input.onLifecycleProjectionError?.(cause, event);
  }
}

export function interruptibleWorkflowSource(fixture: NativeFixture): string {
  const withCapability = fixture.workflowSource.replace(
    "capabilities:\n  - agents\n",
    "capabilities:\n  - agents\n  - hitl\n"
  );
  return [
    withCapability.trimEnd(),
    "  - id: approve",
    "    type: human_gate",
    "    uses: hitl.approval",
    "    input:",
    "      prompt: Approve this Studio run?",
    "    after:",
    "      - analyze",
    ""
  ].join("\n");
}

export function policyBearingAgentAndPatternSource(
  fixture: NativeFixture
): string {
  const withCapabilities = fixture.workflowSource.replace(
    "capabilities:\n  - agents\n",
    "capabilities:\n  - agents\n  - quality-gates\n  - change-request\n"
  );
  const withAgentPolicy = withCapabilities.replace(
    "    output_schema: output.schema.json\n    input:",
    [
      "    output_schema: output.schema.json",
      "    policies:",
      "      - uses: change-request.create_side_effect",
      "        config:",
      "          operation_id: change-request.create",
      "    input:"
    ].join("\n")
  );
  return [
    withAgentPolicy.trimEnd(),
    "  - id: policy-pattern",
    "    type: pattern",
    "    uses: quality-gates.gated_agent_loop",
    "    worker: pinned-agent",
    "    policies:",
    "      - uses: change-request.create_side_effect",
    "        config:",
    "          operation_id: change-request.create",
    "    gates:",
    "      - id: diff",
    "        type: quality-gates.non_empty_diff",
    "        input: {}",
    "    after:",
    "      - analyze",
    ""
  ].join("\n");
}

export function replaySafeBuiltInWorkflowSource(): string {
  return [
    "id: pinned-workflow",
    "type: workflow",
    "mode: read_only",
    "input_schema: input.schema.json",
    "output_schema: output.schema.json",
    "config:",
    "  file: pinned-workflow.yaml",
    "  schema: config.schema.json",
    "capabilities:",
    "  - context",
    "requires:",
    "  repository: false",
    "execution:",
    "  max_concurrency: 1",
    "nodes:",
    "  - id: analyze",
    "    type: built_in",
    "    uses: context.collect_context",
    "    input:",
    "      agents: []",
    ""
  ].join("\n");
}

export async function waitForRun(
  ledger: RunLedgerPort,
  runId: string,
  status: "succeeded" | "failed"
): Promise<void> {
  await vi.waitFor(async () => {
    const record = await ledger.get(runId);
    expect(record).toMatchObject({ run_status: status });
  });
}

export async function cleanupNativeLaunchFixtures(): Promise<void> {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    })
  );
}
