import { describe, expect, it, vi } from "vitest";
import type {
  AdapterContext,
  RegisteredInputAdapter
} from "../../../src/adapters/types.js";
import {
  createNativeStudioAdapterContext,
  loadNativeStudioInputAdapter,
  nativeStudioAdapterOperationSignal
} from "../../../src/studio/adapters/native/input-adapter-execution.js";

describe("native Studio input adapter execution", () => {
  it("enforces the declared timeout when an adapter ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      const adapter: RegisteredInputAdapter = {
        id: "ignores-abort",
        description: "Adapter timeout fixture",
        source: "fixture",
        loadEffects: [],
        load: async () => await new Promise<never>(() => undefined)
      };
      const signal = nativeStudioAdapterOperationSignal(undefined, 25);
      const outcome = loadNativeStudioInputAdapter(
        adapter,
        { kind: "cli", value: "opaque" },
        createNativeStudioAdapterContext("/project", "/config"),
        signal
      ).catch((cause: unknown) => cause);

      await vi.advanceTimersByTimeAsync(25);

      await expect(outcome).resolves.toMatchObject({ name: "TimeoutError" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates the operation signal into adapter JSON commands", async () => {
    const controller = new AbortController();
    let commandSignal: AbortSignal | undefined;
    const context: AdapterContext = {
      projectRoot: "/project",
      configRoot: "/config",
      env: {},
      fetch,
      executeJson: async (_command, _args, options) => {
        commandSignal = options?.signal;
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true }
          );
        });
      }
    };
    const adapter: RegisteredInputAdapter = {
      id: "command-adapter",
      description: "Command signal fixture",
      source: "fixture",
      loadEffects: ["process_execution"],
      load: async (_input, adapterContext) => {
        await adapterContext.executeJson("ignored", []);
        throw new Error("unreachable");
      }
    };
    const outcome = loadNativeStudioInputAdapter(
      adapter,
      { kind: "cli", value: "opaque" },
      context,
      controller.signal
    );

    controller.abort(new Error("cancelled by test"));

    await expect(outcome).rejects.toThrow("cancelled by test");
    expect(commandSignal?.aborted).toBe(true);
  });
});
