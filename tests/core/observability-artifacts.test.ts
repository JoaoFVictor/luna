import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../../src/core/artifact-store.js";
import { createJsonlEventSink } from "../../src/core/observability/jsonl-sink.js";
import {
  createObservabilitySummary,
  recordFailedStep,
  recordPromptOperation,
  recordPromptUsage,
  recordRejectedCapability,
  usageFromFlueResponse
} from "../../src/core/observability/summary.js";

async function initializedStore(): Promise<{
  root: string;
  runDirectory: string;
  store: ArtifactStore;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-observability-"));
  const store = new ArtifactStore(root, "run-1");
  const runDirectory = await store.initializeRunDirectory();

  return { root, runDirectory, store };
}

describe("observability artifacts", () => {
  it("touches artifacts and appends lines with 0600 permissions", async () => {
    const { runDirectory, store } = await initializedStore();

    const touchedPath = await store.touchArtifact("events.jsonl");
    const appendedPath = await store.appendLine("events.jsonl", { ok: true });

    expect(touchedPath).toBe(path.join(runDirectory, "events.jsonl"));
    expect(appendedPath).toBe(touchedPath);
    await expect(readFile(touchedPath, "utf8")).resolves.toBe(
      "{\"ok\":true}\n"
    );
    expect((await stat(touchedPath)).mode & 0o777).toBe(0o600);
  });

  it("JSONL event sink creates events.jsonl on creation and writes one sanitized flat event per line", async () => {
    const { runDirectory, store } = await initializedStore();
    const sink = await createJsonlEventSink(store);
    const eventsPath = path.join(runDirectory, "events.jsonl");

    await expect(readFile(eventsPath, "utf8")).resolves.toBe("");

    await sink.append({
      event: "luna.prompt.completed",
      run_id: "run-1",
      workflow_id: "code-review",
      schema_version: 1,
      event_id: "event-1",
      sequence: 1,
      timestamp: "2026-06-20T12:00:00.000Z",
      level: "info",
      prompt_id: "prompt-1",
      attributes: {
        prompt_text: "raw prompt",
        count: 1n
      }
    });
    await sink.append({
      event: "luna.warning",
      run_id: "run-1",
      workflow_id: "code-review",
      schema_version: 1,
      event_id: "event-2",
      sequence: 2,
      timestamp: "2026-06-20T12:00:01.000Z",
      level: "warn",
      error: new Error("boom")
    });

    const lines = (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      event: "luna.prompt.completed",
      run_id: "run-1",
      workflow_id: "code-review",
      prompt_id: "prompt-1",
      attributes: {
        prompt_text: "[REDACTED]",
        count: "1"
      }
    });
    expect(lines[0]).not.toHaveProperty("type");
    expect(lines[0]).not.toHaveProperty("run");
    expect(lines[0]).not.toHaveProperty("workflow");
    expect(lines[1].error).toMatchObject({
      name: "Error",
      message: "boom"
    });
    expect((await stat(eventsPath)).mode & 0o777).toBe(0o600);
  });

  it("records observability summary data and extracts Flue prompt usage records", () => {
    const summary = createObservabilitySummary({
      runId: "run-1",
      workflowId: "code-review"
    });

    expect(() => recordPromptOperation(summary, undefined)).not.toThrow();
    expect(() => recordPromptUsage(summary, undefined)).not.toThrow();

    recordPromptOperation(summary, {
      durationMs: 25
    });
    const usageRecord = usageFromFlueResponse({
      promptId: "prompt-1",
      modelProfile: "deep",
      response: {
        data: {},
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
        model: {
          provider: "openai",
          id: "gpt-test"
        }
      }
    });

    expect(usageRecord).toEqual({
      prompt_id: "prompt-1",
      model_profile: "deep",
      provider: "openai",
      model: "gpt-test",
      tokens: {
        input: 10,
        output: 5,
        cache_read: 2,
        cache_write: 1,
        total: 18
      },
      cost: {
        input: 0.01,
        output: 0.02,
        cache_read: 0.001,
        cache_write: 0.002,
        total: 0.033,
        unit: "provider_cost_unit"
      }
    });
    recordPromptUsage(summary, usageRecord);
    recordFailedStep(summary, {
      stepId: "validate",
      code: "validation_failed",
      message: "Validation failed"
    });
    recordRejectedCapability(summary, {
      agentId: "reviewer",
      capability: "tool",
      id: "repository.write",
      reason: "mode_not_allowed"
    });

    expect(summary).toMatchObject({
      schema_version: 1,
      run_id: "run-1",
      workflow_id: "code-review",
      events_path: "events.jsonl",
      prompt_operations: 1,
      prompt_duration_ms: 25,
      tokens: {
        input: 10,
        output: 5,
        cache_read: 2,
        cache_write: 1,
        total: 18
      },
      cost: {
        input: 0.01,
        output: 0.02,
        cache_read: 0.001,
        cache_write: 0.002,
        total: 0.033,
        unit: "provider_cost_unit"
      },
      failed_steps: [
        {
          step_id: "validate",
          code: "validation_failed",
          message: "Validation failed"
        }
      ],
      rejected_capabilities: [
        {
          agent_id: "reviewer",
          capability: "tool",
          id: "repository.write",
          reason: "mode_not_allowed"
        }
      ]
    });
  });

  it("returns undefined usage when Flue response has no usage or model", () => {
    expect(
      usageFromFlueResponse({
        promptId: "prompt-1",
        modelProfile: "deep",
        response: { data: {} }
      })
    ).toBeUndefined();
  });

  it("writes observability-summary.json best effort without touching run.json", async () => {
    const { runDirectory, store } = await initializedStore();
    await store.writeJson("run.json", { strict: true });
    const summary = createObservabilitySummary({
      runId: "run-1",
      workflowId: "code-review"
    });

    await expect(summary.write(store)).resolves.toBe(true);

    await expect(readFile(path.join(runDirectory, "run.json"), "utf8")).resolves.toBe(
      "{\n  \"strict\": true\n}\n"
    );
    await expect(
      readFile(path.join(runDirectory, "observability-summary.json"), "utf8")
    ).resolves.toContain("\"events_path\": \"events.jsonl\"");
  });

  it("suppresses summary write failures", async () => {
    const summary = createObservabilitySummary({
      runId: "run-1",
      workflowId: "code-review"
    });
    const store = {
      writeJson: vi.fn(async () => {
        throw new Error("write failed");
      })
    } as unknown as ArtifactStore;

    await expect(summary.write(store)).resolves.toBe(false);
  });
});
