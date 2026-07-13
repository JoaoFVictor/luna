import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createPiImagegenProviderFactory,
  createPiImagegenSession
} from "../../../src/agent-runtimes/pi/image-generation-extension.js";
import type { ImageGenerationExecutionOptions } from "../../../src/capabilities/image-generation/contracts.js";

const VALID_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const input = {
  operation_id: "image-generation.generate" as const,
  provider_id: "pi-imagegen" as const,
  prompt: "A lunar scene",
  size: "1024x1024" as const,
  quality: "medium" as const,
  project_root: "/repo"
};
const execution = (
  overrides: Partial<ImageGenerationExecutionOptions> = {}
): ImageGenerationExecutionOptions => ({
  timeoutMs: 1_000,
  maxImageBytes: 1024 * 1024,
  ...overrides
});

function factoryFor(execute: ReturnType<typeof vi.fn>, dispose = vi.fn()) {
  return {
    factory: createPiImagegenProviderFactory({
      createSession: async () => ({
        extensionRunner: { createContext: () => ({}) as never },
        getToolDefinition: () => ({ name: "imagegen", execute }) as never,
        dispose
      })
    }),
    dispose
  };
}

describe("Pi imagegen extension", () => {
  it("loads the installed pi-imagegen extension and registers its tool", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "luna-pi-imagegen-"));
    const session = await createPiImagegenSession(projectRoot);
    try {
      expect(session.getToolDefinition("imagegen")?.name).toBe("imagegen");
    } finally {
      session.dispose();
    }
  });

  it("executes the registered tool and maps its PNG result", async () => {
    const execute = vi.fn(async (
      _toolCallId: string,
      _input: Record<string, unknown>,
      _signal: unknown,
      _events: unknown,
      _context: unknown
    ) => ({
      content: [
        { type: "text" as const, text: "generated" },
        { type: "image" as const, data: VALID_PNG_BASE64, mimeType: "image/png" }
      ],
      details: {
        provider: "openai-codex",
        imageModel: "gpt-image-2",
        revisedPrompt: "A revised lunar scene",
        savedPath: "/repo/.luna/generated-images/result.png"
      }
    }));
    const { factory, dispose } = factoryFor(execute);

    const generated = await factory.createProvider().generateImage(input, execution());
    expect(generated).toMatchObject({
      provider: "pi-imagegen",
      provider_id: "pi-imagegen",
      model: "gpt-image-2",
      revised_prompt: "A revised lunar scene",
      image_base64: VALID_PNG_BASE64,
      metadata: { provider: "pi-imagegen", model: "gpt-image-2" }
    });
    expect(JSON.stringify(generated)).not.toContain("openai-codex");

    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/^luna-/),
      expect.objectContaining({
        prompt: "A lunar scene",
        outputFormat: "png",
        outputPath: expect.stringMatching(/luna-pi-imagegen-.*\/image\.png$/)
      }),
      expect.any(AbortSignal),
      undefined,
      expect.anything()
    );
    const outputPath = (execute.mock.calls[0]?.[1] as { outputPath: string }).outputPath;
    await expect(access(path.dirname(outputPath))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("times out an extension call, aborts its signal, and cleans up", async () => {
    let receivedSignal: AbortSignal | undefined;
    const execute = vi.fn(async (
      _toolCallId: string,
      _input: Record<string, unknown>,
      signal: AbortSignal
    ) => {
      receivedSignal = signal;
      return await new Promise<never>(() => undefined);
    });
    const { factory, dispose } = factoryFor(execute);

    await expect(factory.createProvider().generateImage(input, execution({ timeoutMs: 5 })))
      .rejects.toMatchObject({ code: "image_generation_timeout" });
    expect(receivedSignal?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("bounds stalled session initialization and disposes a session that arrives late", async () => {
    const execute = vi.fn();
    const dispose = vi.fn();
    let resolveSession: ((session: {
      extensionRunner: { createContext(): never };
      getToolDefinition(): never;
      dispose(): void;
    }) => void) | undefined;
    const factory = createPiImagegenProviderFactory({
      createSession: async () => await new Promise((resolve) => {
        resolveSession = resolve;
      })
    });

    await expect(factory.createProvider().generateImage(
      input,
      execution({ timeoutMs: 5 })
    )).rejects.toMatchObject({ code: "image_generation_timeout" });

    resolveSession?.({
      extensionRunner: { createContext: () => ({}) as never },
      getToolDefinition: () => ({ name: "imagegen", execute }) as never,
      dispose
    });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(execute).not.toHaveBeenCalled();
  });

  it("propagates caller cancellation to the extension and cleans up", async () => {
    let receivedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const execute = vi.fn(async (
      _toolCallId: string,
      _input: Record<string, unknown>,
      signal: AbortSignal
    ) => {
      receivedSignal = signal;
      markStarted?.();
      return await new Promise<never>(() => undefined);
    });
    const { factory, dispose } = factoryFor(execute);
    const controller = new AbortController();
    const pending = factory.createProvider().generateImage(
      input,
      execution({ signal: controller.signal })
    );
    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "image_generation_aborted" });
    expect(receivedSignal?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ["before decode", "A".repeat(16)],
    ["after decode", "iVBORw0KGgoA"]
  ])("rejects an oversized payload %s", async (_case, imageBase64) => {
    const execute = vi.fn(async () => ({
      content: [{ type: "image" as const, data: imageBase64, mimeType: "image/png" }],
      details: { imageModel: "gpt-image-2", savedPath: "/tmp/image.png" }
    }));
    const { factory, dispose } = factoryFor(execute);

    await expect(factory.createProvider().generateImage(
      input,
      execution({ maxImageBytes: 8 })
    )).rejects.toMatchObject({ code: "image_generation_payload_too_large" });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
