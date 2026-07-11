import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  waitForStudioShutdown,
  type StudioShutdownSignalSource
} from "../../../src/studio/server/graceful-shutdown.js";

function signals() {
  const emitter = new EventEmitter();
  const source: StudioShutdownSignalSource = {
    once: (signal, listener) => emitter.once(signal, listener),
    removeListener: (signal, listener) =>
      emitter.removeListener(signal, listener)
  };
  return { emitter, source };
}

describe("Studio graceful shutdown", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "closes exactly once after %s and removes both handlers",
    async (signal) => {
      const source = signals();
      const close = vi.fn(async () => undefined);
      const stopped = waitForStudioShutdown({ close }, source.source);

      source.emitter.emit(signal);
      source.emitter.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
      await stopped;

      expect(close).toHaveBeenCalledOnce();
      expect(source.emitter.listenerCount("SIGINT")).toBe(0);
      expect(source.emitter.listenerCount("SIGTERM")).toBe(0);
    }
  );

  it("propagates cleanup failure to the CLI boundary", async () => {
    const source = signals();
    const stopped = waitForStudioShutdown(
      { close: async () => { throw new Error("close failed"); } },
      source.source
    );

    source.emitter.emit("SIGTERM");

    await expect(stopped).rejects.toThrow("close failed");
  });
});
