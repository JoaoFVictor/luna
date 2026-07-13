import { describe, expect, it, vi } from "vitest";
import {
  createPiAgentRuntimeAdapter,
  type PiModels
} from "../../../src/agent-runtimes/pi/adapter.js";
import type {
  RunAgentInput
} from "../../../src/core/agent-runtime/contracts.js";
import type { ResolvedToolCatalog } from "../../../src/core/tools/resolved-catalog.js";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";

function message(
  content: AssistantMessage["content"],
  overrides: Record<string, unknown> = {}
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-5.4-mini",
    usage: {
      input: 3,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: 1,
    ...overrides
  } as AssistantMessage;
}

const fakeModel = {
  id: "gpt-5.4-mini",
  name: "GPT 5.4 Mini",
  api: "openai-responses",
  provider: "openai-codex",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
} as Model<string>;

function injectedModels(
  complete: unknown,
  getModel: unknown
): PiModels {
  return { complete, getModel } as unknown as PiModels;
}

function input(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    run: {
      run_id: "run-1",
      workflow_id: "workflow-1",
      attempt: 1,
      started_at: "2026-06-26T00:00:00.000Z"
    },
    node_id: "node-1",
    agent_id: "agent-1",
    agent_mode: "read_only",
    instructions: "Run.",
    input: { task: "summarize" },
    output_schema: {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
      additionalProperties: false
    },
    model_profile: {
      model: "openai-codex/gpt-5.4-mini",
      reasoning_effort: "low"
    },
    tools: { tools: [], runtime_requirements: [] },
    context: undefined,
    runtime_requirements: [],
    signal: undefined,
    events: undefined,
    ...overrides
  };
}

describe("Pi agent runtime adapter", () => {
  it("runs a model request and parses final JSON output", async () => {
    const complete = vi.fn(
      async (
        _model: Model<string>,
        _context: Context,
        _options?: Record<string, unknown>
      ) => message([{ type: "text", text: "{\"summary\":\"ok\"}" }])
    );
    const getModel = vi.fn(() => fakeModel);
    const adapter = createPiAgentRuntimeAdapter({
      models: injectedModels(complete, getModel)
    });

    await expect(adapter.runAgent(input())).resolves.toMatchObject({
      output: { summary: "ok" },
      usage: {
        input_tokens: 3,
        output_tokens: 5,
        total_tokens: 8
      },
      runtime_metadata: {
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        stop_reason: "stop"
      }
    });
    expect(getModel).toHaveBeenCalledWith("openai-codex", "gpt-5.4-mini");
  });

  it("passes generic provider options through the model registry", async () => {
    const complete = vi.fn(
      async (
        _model: Model<string>,
        _context: Context,
        _options?: Record<string, unknown>
      ) => message([{ type: "text", text: "{\"summary\":\"ok\"}" }])
    );
    const getModel = vi.fn(() => fakeModel);
    const adapter = createPiAgentRuntimeAdapter({
      models: injectedModels(complete, getModel)
    });

    await expect(
      adapter.runAgent(
        input({
          model_profile: {
            provider: "test-provider",
            model: "gpt-5.4-mini",
            reasoning_effort: "low"
          }
        })
      )
    ).resolves.toMatchObject({ output: { summary: "ok" } });

    expect(complete.mock.calls[0]?.[2]).toMatchObject({
      reasoning: "low",
      sessionId: expect.stringMatching(/^luna-/)
    });
    expect(complete.mock.calls[0]?.[2]).not.toHaveProperty("apiKey");
  });

  it("times out model requests that do not settle", async () => {
    const complete = vi.fn(
        () => new Promise<AssistantMessage>(() => {
          // Intentionally never settles.
        })
      );
    const adapter = createPiAgentRuntimeAdapter({
      models: injectedModels(complete, vi.fn(() => fakeModel)),
      requestTimeoutMs: 5
    });

    await expect(adapter.runAgent(input())).rejects.toMatchObject({
      code: "runtime_provider_unavailable"
    });
  });

  it("uses a provider-safe Pi session id instead of the raw Luna run id", async () => {
    const complete = vi.fn(
      async (
        _model: Model<string>,
        _context: Context,
        _options?: Record<string, unknown>
      ) => message([{ type: "text", text: "{\"summary\":\"ok\"}" }])
    );
    const adapter = createPiAgentRuntimeAdapter({
      models: injectedModels(complete, vi.fn(() => fakeModel))
    });
    const longRunId = `run-${"x".repeat(140)}`;

    await expect(
      adapter.runAgent(input({ run: { ...input().run, run_id: longRunId } }))
    ).resolves.toMatchObject({ output: { summary: "ok" } });

    const options = complete.mock.calls[0]?.[2];
    expect(String(options?.sessionId).length).toBeLessThanOrEqual(64);
    expect(options?.sessionId).not.toBe(longRunId);
  });

  it("executes local tool calls before returning final output", async () => {
    const calls = [
      message(
        [
          {
            type: "toolCall",
            id: "call-1",
            name: "repository_status",
            arguments: {}
          }
        ],
        { stopReason: "toolUse" }
      ),
      message([{ type: "text", text: "{\"summary\":\"clean\"}" }])
    ];
    const complete = vi.fn(async (_model: Model<string>, _context: Context) =>
      calls.shift() ?? message([])
    );
    const getModel = vi.fn(() => fakeModel);
    const handler = vi.fn(async () => " M src/index.ts\n");
    const createHandler = vi.fn(() => handler);
    const controller = new AbortController();
    const tools: ResolvedToolCatalog = {
      tools: [
        {
          id: "repository.status",
          protocol: "local",
          input_schema: { type: "object", additionalProperties: false },
          output_schema: { type: "string" },
          runtime_requirements: ["tool_calling"],
          source: "local_contract",
          local: {
            id: "repository.status",
            description: "Status",
            input_schema: { type: "object", additionalProperties: false },
            output_schema: { type: "string" },
            safety: {
              localWrites: false,
              network: false,
              externalSideEffects: false
            },
            modes: ["read_only", "trusted_local_write"],
            runtime_requirements: ["tool_calling"],
            createHandler
          }
        }
      ],
      runtime_requirements: ["tool_calling"]
    };
    const adapter = createPiAgentRuntimeAdapter({
      models: injectedModels(complete, getModel)
    });

    await expect(
      adapter.runAgent(
        input({
          tools,
          runtime_requirements: ["tool_calling"],
          cwd: "/tmp/repo",
          signal: controller.signal
        })
      )
    ).resolves.toMatchObject({ output: { summary: "clean" } });
    expect(createHandler).toHaveBeenCalledWith({
      cwd: "/tmp/repo",
      agentInput: expect.any(Object),
      signal: controller.signal
    });
    expect(handler).toHaveBeenCalledWith({});
    expect(complete).toHaveBeenCalledTimes(2);
    const secondContext = complete.mock.calls[1]?.[1];
    expect(secondContext?.messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "repository_status",
        isError: false
      })
    );
  });

});
