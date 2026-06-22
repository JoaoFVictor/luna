import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../../src/core/artifacts/store.js";
import type { AgentDefinition } from "../../src/core/agents/definition.js";
import { createLunaObservability } from "../../src/core/observability/luna-observability.js";
import {
  createObservabilitySummary,
  type ObservabilitySummary
} from "../../src/core/observability/summary.js";
import type { RunAgentStepOptions } from "../../src/core/configured-workflow/runner.js";
import type { LunaEvent } from "../../src/core/observability/events.js";
import { runFlueAgentStep } from "../../src/core/agent-runtime/flue/runner.js";

async function testAgent(root: string): Promise<AgentDefinition> {
  const directory = path.join(root, "agents", "reviewer");
  await mkdir(directory, { recursive: true });
  const instructionsPath = path.join(directory, "instructions.md");
  const outputSchemaPath = path.join(directory, "output.schema.json");
  await writeFile(instructionsPath, "Review the input.\n", "utf8");
  await writeFile(
    outputSchemaPath,
    JSON.stringify({
      type: "object",
      additionalProperties: true
    }),
    "utf8"
  );

  return {
    id: "reviewer",
    description: "Review agent",
    model_profile: "deep",
    mode: "read_only",
    instructions_file: "instructions.md",
    output_schema: "output.schema.json",
    directory,
    instructionsPath,
    outputSchemaPath
  };
}

async function promptHarness({
  prompt
}: {
  prompt: (text: string, options?: unknown) => Promise<unknown>;
}) {
  return {
    id: "flue-run-1",
    payload: {},
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    },
    init: vi.fn(async () => ({
      session: vi.fn(async () => ({
        prompt
      }))
    }))
  };
}

async function observabilityFixture(root: string): Promise<{
  artifactStore: ArtifactStore;
  summary: ObservabilitySummary;
  events: LunaEvent[];
}> {
  const artifactStore = new ArtifactStore(path.join(root, "artifacts"), "run-1");
  await artifactStore.initializeRunDirectory();
  const summary = createObservabilitySummary({
    runId: "run-1",
    workflowId: "code-review"
  });
  const events: LunaEvent[] = [];
  return {
    artifactStore,
    summary,
    events
  };
}

function stepOptions({
  agent,
  artifactStore,
  summary,
  events
}: {
  agent: AgentDefinition;
  artifactStore: ArtifactStore;
  summary: ObservabilitySummary;
  events: LunaEvent[];
}): RunAgentStepOptions {
  return {
    agent,
    node: {
      id: "review",
      type: "agent",
      agent: "reviewer",
      output_schema: "review"
    },
    model: { model: "openai/gpt-test", reasoning_effort: "medium" },
    agentsRoot: path.dirname(agent.directory),
    modelProfiles: {
      deep: { model: "openai/gpt-test", reasoning_effort: "medium" }
    },
    workflowSubagentPolicy: { allow_write: false },
    input: { subject: "hello" },
    state: {
      invocation: { version: "2026-06", source: "github", event: "pull_request" },
      config: {},
      run: {
        run_id: "run-1",
        workflow_id: "code-review",
        attempt: 1,
        source: "github",
        event: "pull_request",
        started_at: "2026-06-20T00:00:00.000Z"
      },
      workflow: { id: "code-review", mode: "read_only" },
      workspaceRoot: ".workspaces",
      steps: {}
    },
    observability: createLunaObservability({
      run: { id: "run-1", runtimeRunId: "flue-run-1", attempt: 1 },
      workflow: { id: "code-review" },
      sinks: [
        {
          id: "memory",
          required: true,
          append: (event) => {
            events.push(event);
          }
        }
      ]
    }),
    summary,
    artifactStore
  };
}

describe("Flue prompt usage observability", () => {
  it("records usage, duration, stable prompt id, and summary for agent prompt success", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-flue-prompt-"));
    const agent = await testAgent(root);
    const fixture = await observabilityFixture(root);
    const ctx = await promptHarness({
      prompt: vi.fn(async () => ({
        data: { summary: "ok" },
        usage: {
          input: 10,
          output: 5,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 18,
          cost: {
            input: 0.01,
            output: 0.02,
            cacheRead: 0.001,
            cacheWrite: 0.002,
            total: 0.033
          }
        },
        model: { provider: "openai", id: "gpt-test" }
      }))
    });

    await expect(
      runFlueAgentStep(ctx as never, stepOptions({ agent, ...fixture }))
    ).resolves.toEqual({ summary: "ok" });

    const promptEvents = fixture.events.filter((event) =>
      event.type.startsWith("luna.prompt.")
    );

    expect(promptEvents.map((event) => event.type)).toEqual([
      "luna.prompt.started",
      "luna.prompt.finished"
    ]);
    expect(promptEvents[0]).toMatchObject({
      data: {
        prompt_id: "agent:review",
        agent_id: "reviewer"
      }
    });
    expect(promptEvents[1]?.data?.duration_ms).toEqual(expect.any(Number));
    expect(fixture.summary).toMatchObject({
      prompt_operations: 1,
      tokens: {
        input: 10,
        output: 5,
        cache_read: 2,
        cache_write: 1,
        total: 18
      },
      cost: {
        total: 0.033,
        unit: "provider_cost_unit"
      }
    });
    await expect(
      readFile(
        path.join(root, "artifacts", "run-1", "observability-summary.json"),
        "utf8"
      )
    ).resolves.toContain("\"prompt_operations\": 1");
  });

  it("records missing usage when an agent prompt succeeds without usage data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-flue-prompt-"));
    const agent = await testAgent(root);
    const fixture = await observabilityFixture(root);
    const ctx = await promptHarness({
      prompt: vi.fn(async () => ({
        data: { summary: "ok" }
      }))
    });

    await expect(
      runFlueAgentStep(ctx as never, stepOptions({ agent, ...fixture }))
    ).resolves.toEqual({ summary: "ok" });

    const promptEvents = fixture.events.filter((event) =>
      event.type.startsWith("luna.prompt.")
    );

    expect(promptEvents.map((event) => event.type)).toEqual([
      "luna.prompt.started",
      "luna.prompt.usage_missing",
      "luna.prompt.finished"
    ]);
    expect(promptEvents[1]).toMatchObject({
      type: "luna.prompt.usage_missing",
      outcome: { status: "succeeded" },
      data: {
        prompt_id: "agent:review"
      }
    });
    expect(fixture.summary).toMatchObject({
      prompt_operations: 1,
      usage_missing_count: 1,
      tokens: {
        total: 0
      }
    });
    await expect(
      readFile(
        path.join(root, "artifacts", "run-1", "observability-summary.json"),
        "utf8"
      )
    ).resolves.toContain("\"usage_missing_count\": 1");
  });

  it("records prompt operation duration and failed event when agent prompt has no usage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-flue-prompt-"));
    const agent = await testAgent(root);
    const fixture = await observabilityFixture(root);
    const failure = Object.assign(new Error("model failed"), {
      code: "model_failed"
    });
    const ctx = await promptHarness({
      prompt: vi.fn(async () => {
        throw failure;
      })
    });

    await expect(
      runFlueAgentStep(ctx as never, stepOptions({ agent, ...fixture }))
    ).rejects.toBe(failure);

    const promptEvents = fixture.events.filter((event) =>
      event.type.startsWith("luna.prompt.")
    );

    expect(promptEvents.map((event) => event.type)).toEqual([
      "luna.prompt.started",
      "luna.prompt.failed"
    ]);
    expect(promptEvents[1]).toMatchObject({
      data: {
        prompt_id: "agent:review",
        error: {
          message: "model failed",
          code: "model_failed"
        }
      }
    });
    expect(fixture.summary).toMatchObject({
      prompt_operations: 1,
      tokens: {
        total: 0
      }
    });
    await expect(
      readFile(
        path.join(root, "artifacts", "run-1", "observability-summary.json"),
        "utf8"
      )
    ).resolves.toContain("\"prompt_operations\": 1");
  });
});
