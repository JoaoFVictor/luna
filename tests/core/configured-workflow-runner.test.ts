import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runConfiguredWorkflow } from "../../src/core/configured-workflow/runner.js";
import type { LunaEvent } from "../../src/core/observability/events.js";
import type { RunIdentityOptions } from "../../src/core/run-identity.js";
import type {
  Invocation,
  RunIdentity,
  WorkspaceRecord
} from "../../src/core/types.js";
import {
  acceptedDecision,
  artifactPath,
  deferred,
  githubRun,
  invocation,
  jiraInvocation,
  jiraRun,
  pathExists,
  readJson,
  staticRunIdentity,
  withTimeout,
  writeAgent,
  writeBaseConfig,
  writeFullCodeReviewWorkflow,
  writeImplementationConfig,
  writeImplementationWorkflow,
  writePreflightWorkflow,
  writeReviewPlannerAgent,
  writeWorkflow
} from "./configured-workflow-runner-test-helpers.js";

async function writeConfigInputWorkflow(root: string): Promise<void> {
  await mkdir(path.join(root, "workflows", "config-input-review"), {
    recursive: true
  });
  await writeFile(
    path.join(root, "workflows", "config-input-review", "workflow.yaml"),
    [
      "id: config-input-review",
      "type: workflow",
      "mode: git_managed_read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflows", "config-input-review", "graph.yaml"),
    [
      "nodes:",
      "  - id: config_probe",
      "    type: built_in",
      "    uses: preflight",
      "    artifacts:",
      "      - path: config-probe.json",
      "        source: $.steps.config_probe",
      "        format: json",
      "    input:",
      "      commands: $.config.implementation.validation.commands",
      ""
    ].join("\n")
  );
}

async function writeParallelProbeWorkflow(root: string): Promise<void> {
  await mkdir(path.join(root, "workflows", "parallel-probe"), {
    recursive: true
  });
  await writeFile(
    path.join(root, "routing.yaml"),
    [
      "routes:",
      "  - name: explicit-target",
      "    when:",
      "      has_target: true",
      "    use_target_from_input: true",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflows", "parallel-probe", "workflow.yaml"),
    [
      "id: parallel-probe",
      "type: workflow",
      "mode: git_managed_read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      "execution:",
      "  max_concurrency: 2",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflows", "parallel-probe", "graph.yaml"),
    [
      "nodes:",
      "  - id: node-a",
      "    type: built_in",
      "    uses: preflight",
      "  - id: node-b",
      "    type: built_in",
      "    uses: collect_repo_context",
      ""
    ].join("\n")
  );
}


describe("configured workflow runner", () => {
  it("routes and uses routed workflow options when creating the final run identity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);

      const fixedDate = new Date("2026-06-20T12:34:56.789Z");
      const createRunIdentity = vi.fn(
        (receivedInvocation: Invocation, options: RunIdentityOptions): RunIdentity => ({
          run_id: `run-${options.workflowId}`,
          ...(options.runtimeRunId === undefined
            ? {}
            : { flue_run_id: options.runtimeRunId }),
          workflow_id: options.workflowId,
          attempt: options.attempt,
          source: receivedInvocation.source,
          event: receivedInvocation.event,
          ...(receivedInvocation.action === undefined
            ? {}
            : { action: receivedInvocation.action }),
          ...(receivedInvocation.target === undefined
            ? {}
            : { route_target: receivedInvocation.target }),
          ...(receivedInvocation.subject === undefined
            ? {}
            : {
                subject: {
                  type: receivedInvocation.subject.type,
                  id: receivedInvocation.subject.id
                }
              }),
          started_at: options.date.toISOString()
        })
      );

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        runtimeRunId: "flue-1",
        nonceFactory: () => "nonce-1",
        dependencies: {
          now: () => fixedDate,
          createRunIdentity,
          runBuiltInStep: vi.fn(async ({ uses }: { uses: string }) =>
            uses === "collect_repo_context" ? { files: [] } : { status: "ok" }
          ),
          runAgentStep: vi.fn(async () => ({
            summary: "Plan",
            focus_areas: [],
            files_to_review: []
          }))
        }
      });

      expect(result.status).toBe("success");
      expect(createRunIdentity).toHaveBeenCalledWith(
        invocation,
        expect.objectContaining({
          workflowId: "code-review",
          runtimeRunId: "flue-1",
          nonce: "nonce-1",
          attempt: 1,
          date: fixedDate
        })
      );
      await expect(
        readJson(root, "code-review", "run-code-review", "run.json")
      ).resolves.toMatchObject({
        workflow_id: "code-review",
        flue_run_id: "flue-1"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes pre-route failures under the failed workflow namespace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);

      const fixedDate = new Date("2026-06-20T00:00:00.000Z");
      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        throwOnError: false,
        nonceFactory: () => "pre",
        dependencies: {
          now: () => fixedDate,
          routeInvocation: () => {
            throw Object.assign(new Error("No route matched"), {
              code: "route_not_found"
            });
          }
        }
      });

      expect(result.status).toBe("failed");
      expect(result.workflow_id).toBe("_failed");
      await expect(
        pathExists(path.join(root, "artifacts", "_failed"))
      ).resolves.toBe(true);
      const runJson = await readJson(
        root,
        "_failed",
        result.run.run_id,
        "run.json"
      );
      expect(runJson).toMatchObject({
        workflow_id: "_failed"
      });
      expect(runJson).not.toHaveProperty("flue_run_id");
      await expect(
        readJson(root, "_failed", result.run.run_id, "error.json")
      ).resolves.toMatchObject({
        code: "route_not_found",
        run_id: result.run.run_id
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits routed and finished observability events for successful runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);

      const events: LunaEvent[] = [];

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        runtimeRunId: "flue-log",
        nonceFactory: () => "log",
        observabilitySinks: [
          {
            id: "memory",
            required: false,
            append: (event) => {
              events.push(event);
            }
          }
        ],
        dependencies: {
          now: () => new Date("2026-06-20T00:00:00.000Z"),
          createRunIdentity: staticRunIdentity({
            ...githubRun,
            run_id: "run-log",
            flue_run_id: "flue-log"
          }),
          runBuiltInStep: vi.fn(async ({ uses }: { uses: string }) =>
            uses === "collect_repo_context" ? { files: [] } : { status: "ok" }
          ),
          runAgentStep: vi.fn(async () => ({
            summary: "Plan",
            focus_areas: [],
            files_to_review: []
          }))
        }
      });

      expect(result.status).toBe("success");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "luna.run.routed",
            run: { id: "run-log", runtimeRunId: "flue-log", attempt: 1 },
            workflow: { id: "code-review" }
          }),
          expect.objectContaining({
            type: "luna.run.completed",
            run: { id: "run-log", runtimeRunId: "flue-log", attempt: 1 },
            workflow: { id: "code-review" }
          })
        ])
      );
      expect(events.map((event) => event.type)).not.toContain(
        "luna.run.succeeded"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates observability artifacts and uses optional sinks without mutating run.json", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writePreflightWorkflow(root, "code-review");

      const optionalEvents: LunaEvent[] = [];
      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        runtimeRunId: "flue-obs",
        nonceFactory: () => "obs",
        observabilitySinks: [
          {
            id: "optional-test",
            required: false,
            append: (event) => {
              optionalEvents.push(event);
              throw new Error("optional sink unavailable");
            }
          }
        ],
        dependencies: {
          now: () => new Date("2026-06-20T00:00:00.000Z"),
          createRunIdentity: staticRunIdentity({
            ...githubRun,
            run_id: "run-obs",
            flue_run_id: "flue-obs"
          }),
          runBuiltInStep: vi.fn(async () => ({ status: "ok" }))
        }
      });

      expect(result.status).toBe("success");
      expect(optionalEvents.map((event) => event.type)).toContain(
        "luna.run.started"
      );

      const runJson = await readJson(root, "code-review", "run-obs", "run.json");
      expect(runJson).toEqual(
        expect.not.objectContaining({
          prompt_operations: expect.anything(),
          events_path: expect.anything()
        })
      );

      const eventsPath = artifactPath(root, "code-review", "run-obs", "events.jsonl");
      const events = (await readFile(eventsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "luna.run.started",
          "luna.step.started",
          "luna.step.succeeded",
          "luna.run.completed",
          "luna.observability.sink.warning"
        ])
      );

      await expect(
        readJson(root, "code-review", "run-obs", "observability-summary.json")
      ).resolves.toMatchObject({
        run_id: "run-obs",
        workflow_id: "code-review",
        events_path: "events.jsonl",
        prompt_operations: 0
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps events.jsonl when runtime_log exporter is disabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writePreflightWorkflow(root, "code-review", [
        "observability:",
        "  exporters:",
        "    runtime_log:",
        "      enabled: false",
        "      required: false"
      ]);

      const optionalEvents: LunaEvent[] = [];
      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        runtimeRunId: "flue-disabled",
        nonceFactory: () => "disabled",
        observabilitySinks: [
          {
            id: "optional-disabled",
            required: false,
            append: (event) => {
              optionalEvents.push(event);
              throw new Error("disabled sink should not run");
            }
          }
        ],
        dependencies: {
          now: () => new Date("2026-06-20T00:00:00.000Z"),
          createRunIdentity: staticRunIdentity({
            ...githubRun,
            run_id: "run-disabled",
            flue_run_id: "flue-disabled"
          }),
          runBuiltInStep: vi.fn(async () => ({ status: "ok" }))
        }
      });

      expect(result.status).toBe("success");
      expect(optionalEvents).toEqual([]);

      const eventsPath = artifactPath(
        root,
        "code-review",
        "run-disabled",
        "events.jsonl"
      );
      const events = (await readFile(eventsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(events.map((event) => event.type)).toContain(
        "luna.run.completed"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts legacy flue_log exporter config through the configured workflow runtime boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writePreflightWorkflow(root, "code-review", [
        "observability:",
        "  exporters:",
        "    flue_log:",
        "      enabled: false",
        "      required: false"
      ]);

      const optionalEvents: LunaEvent[] = [];
      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        runtimeRunId: "flue-compat",
        nonceFactory: () => "compat",
        observabilitySinks: [
          {
            id: "legacy-flue-log",
            required: false,
            append: (event) => {
              optionalEvents.push(event);
            }
          }
        ],
        dependencies: {
          now: () => new Date("2026-06-20T00:00:00.000Z"),
          createRunIdentity: staticRunIdentity({
            ...githubRun,
            run_id: "run-compat",
            flue_run_id: "flue-compat"
          }),
          runBuiltInStep: vi.fn(async () => ({ status: "ok" }))
        }
      });

      expect(result.status).toBe("success");
      expect(optionalEvents).toEqual([]);
      await expect(
        pathExists(artifactPath(root, "code-review", "run-compat", "events.jsonl"))
      ).resolves.toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects workflow observability configs with both runtime_log and legacy flue_log", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writePreflightWorkflow(root, "code-review", [
        "observability:",
        "  exporters:",
        "    runtime_log:",
        "      enabled: true",
        "    flue_log:",
        "      enabled: false"
      ]);

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        throwOnError: false,
        nonceFactory: () => "dupe",
        dependencies: {
          now: () => new Date("2026-06-20T00:00:00.000Z")
        }
      });

      if (result.status !== "failed") {
        throw new Error(`Expected workflow config failure, got ${result.status}`);
      }
      expect(result.error).toMatchObject({
        code: "workflow_config_read_failed"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let optional observability sink failures mask successful runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        runtimeRunId: "flue-log",
        nonceFactory: () => "log",
        observabilitySinks: [
          {
            id: "optional-failing",
            required: false,
            append: () => {
              throw new Error("observability unavailable");
            }
          }
        ],
        dependencies: {
          now: () => new Date("2026-06-20T00:00:00.000Z"),
          createRunIdentity: staticRunIdentity({
            ...githubRun,
            run_id: "run-log-throw",
            flue_run_id: "flue-log"
          }),
          runBuiltInStep: vi.fn(async ({ uses }: { uses: string }) =>
            uses === "collect_repo_context" ? { files: [] } : { status: "ok" }
          ),
          runAgentStep: vi.fn(async () => ({
            summary: "Plan",
            focus_areas: [],
            files_to_review: []
          }))
        }
      });

      expect(result).toMatchObject({
        status: "success",
        run: { run_id: "run-log-throw" }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits failed observability events for failures after a run exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);

      const events: LunaEvent[] = [];

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        throwOnError: false,
        runtimeRunId: "flue-fail",
        nonceFactory: () => "fail",
        observabilitySinks: [
          {
            id: "memory",
            required: false,
            append: (event) => {
              events.push(event);
            }
          }
        ],
        dependencies: {
          now: () => new Date("2026-06-20T00:00:00.000Z"),
          createRunIdentity: staticRunIdentity({
            ...githubRun,
            run_id: "run-fail",
            flue_run_id: "flue-fail"
          }),
          runBuiltInStep: vi.fn(async () => {
            throw Object.assign(new Error("Preflight failed"), {
              code: "preflight_failed"
            });
          })
        }
      });

      expect(result.status).toBe("failed");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "luna.run.completed",
            run: { id: "run-fail", runtimeRunId: "flue-fail", attempt: 1 },
            workflow: { id: "code-review" },
            outcome: expect.objectContaining({ status: "failed" }),
            data: expect.objectContaining({
              error: expect.objectContaining({
                message: "Workflow scheduler failed"
              })
            })
          })
        ])
      );
      expect(events.map((event) => event.type)).not.toContain(
        "luna.workflow.failed"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let optional observability sink failures mask workflow failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        throwOnError: false,
        runtimeRunId: "flue-fail",
        nonceFactory: () => "fail",
        observabilitySinks: [
          {
            id: "optional-failing",
            required: false,
            append: () => {
              throw new Error("observability unavailable");
            }
          }
        ],
        dependencies: {
          now: () => new Date("2026-06-20T00:00:00.000Z"),
          createRunIdentity: staticRunIdentity({
            ...githubRun,
            run_id: "run-fail-logger",
            flue_run_id: "flue-fail"
          }),
          runBuiltInStep: vi.fn(async () => {
            throw Object.assign(new Error("Preflight failed"), {
              code: "preflight_failed"
            });
          })
        }
      });

      expect(result).toMatchObject({
        status: "failed",
        error: {
          code: "scheduler_step_failed",
          details: { step_id: "preflight", cause_code: "preflight_failed" }
        },
        run: { run_id: "run-fail-logger" }
      });
      await expect(
        readJson(root, "code-review", "run-fail-logger", "error.json")
      ).resolves.toMatchObject({
        code: "scheduler_step_failed",
        details: { step_id: "preflight", cause_code: "preflight_failed" },
        run_id: "run-fail-logger"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes flattened implementation config references to built-in node input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "config-input-review");
      await writeConfigInputWorkflow(root);
      await writeImplementationConfig(root);

      const runBuiltInStep = vi.fn(async () => ({ status: "ok" }));

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep
        }
      });

      expect(result.status).toBe("success");
      expect(runBuiltInStep).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            commands: [{ cmd: "npm", args: ["test"], timeout_ms: 120000 }]
          }
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs configured independent nodes concurrently when max_concurrency is greater than one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "parallel-probe", "real");
      await writeParallelProbeWorkflow(root);

      const startedNodeIds: string[] = [];
      const completedNodeIds: string[] = [];
      let activeNodes = 0;
      let maxObservedConcurrentNodes = 0;
      const releaseNodes = deferred<void>();

      const resultPromise = runConfiguredWorkflow({
        invocation: {
          ...invocation,
          target: { type: "workflow", id: "parallel-probe" }
        },
        configRoot: root,
        dependencies: {
          createRunIdentity: staticRunIdentity({
            ...githubRun,
            run_id: "run-parallel",
            workflow_id: "parallel-probe"
          }),
          runBuiltInStep: vi.fn(async ({ uses }) => {
            const nodeId = uses === "preflight" ? "node-a" : "node-b";
            startedNodeIds.push(nodeId);
            activeNodes += 1;
            maxObservedConcurrentNodes = Math.max(
              maxObservedConcurrentNodes,
              activeNodes
            );
            if (startedNodeIds.length === 2) {
              releaseNodes.resolve();
            }
            await releaseNodes.promise;
            activeNodes -= 1;
            completedNodeIds.push(nodeId);
            return { node_id: nodeId };
          })
        }
      });

      const result = await withTimeout(
        resultPromise,
        1000,
        "configured independent nodes did not overlap"
      );

      expect(result.status).toBe("success");
      expect(maxObservedConcurrentNodes).toBeGreaterThan(1);
      expect(startedNodeIds).toEqual(expect.arrayContaining(["node-a", "node-b"]));
      expect(completedNodeIds).toEqual(
        expect.arrayContaining(["node-a", "node-b"])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
