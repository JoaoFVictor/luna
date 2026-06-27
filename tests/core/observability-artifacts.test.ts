import { describe, expect, it, vi } from "vitest";
import {
  createObservabilitySummary,
  recordFailedStep,
  recordPromptOperation,
  recordPromptUsage,
  recordPromptUsageMissing,
  recordRejectedCapability,
  writeSummaryBestEffort
} from "../../src/core/observability/summary.js";

describe("observability artifacts", () => {
  it("records observability summary data and extracts Pi prompt usage records", () => {
    const summary = createObservabilitySummary({
      runId: "run-1",
      workflowId: "code-review"
    });

    expect(() => recordPromptOperation(summary, undefined)).not.toThrow();
    expect(() => recordPromptUsage(summary, undefined)).not.toThrow();

    recordPromptOperation(summary, {
      durationMs: 25
    });
    const usageRecord = {
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
        unit: "provider_cost_unit" as const
      }
    };

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

  it("records prompt operations without usage as usage_missing_count", () => {
    const summary = createObservabilitySummary({
      runId: "run-1",
      workflowId: "code-review"
    });

    recordPromptOperation(summary, { durationMs: 10 });
    recordPromptUsageMissing(summary);

    expect(summary.usage_missing_count).toBe(1);
  });

  it("writes observability-summary.json through the artifact publisher", async () => {
    const publisher = {
      publish: vi.fn(async () => ({ id: "observability-summary.json" }))
    };
    const summary = createObservabilitySummary({
      runId: "run-1",
      workflowId: "code-review"
    });

    await expect(writeSummaryBestEffort(publisher, summary)).resolves.toBe(true);
    expect(publisher.publish).toHaveBeenCalledWith({
      node_id: "observability",
      path: "observability-summary.json",
      format: "json",
      value: expect.objectContaining({
        run_id: "run-1",
        events_path: "events.jsonl"
      }),
      overwrite_policy: "replace"
    });
  });

  it("suppresses summary write failures", async () => {
    const summary = createObservabilitySummary({
      runId: "run-1",
      workflowId: "code-review"
    });
    const store = {
      publish: vi.fn(async () => {
        throw new Error("write failed");
      })
    };

    await expect(writeSummaryBestEffort(store, summary)).resolves.toBe(false);
  });
});
