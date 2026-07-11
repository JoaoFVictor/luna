import type { StudioServerHandle } from "./studio-server.js";

type StudioShutdownSignal = "SIGINT" | "SIGTERM";

export type StudioShutdownSignalSource = {
  once(signal: StudioShutdownSignal, listener: () => void): void;
  removeListener(signal: StudioShutdownSignal, listener: () => void): void;
};

const processSignalSource: StudioShutdownSignalSource = {
  once(signal, listener) {
    process.once(signal, listener);
  },
  removeListener(signal, listener) {
    process.removeListener(signal, listener);
  }
};

export async function waitForStudioShutdown(
  handle: Pick<StudioServerHandle, "close">,
  signals: StudioShutdownSignalSource = processSignalSource
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const cleanup = () => {
      signals.removeListener("SIGINT", shutdown);
      signals.removeListener("SIGTERM", shutdown);
    };
    const shutdown = () => {
      if (closing) return;
      closing = true;
      cleanup();
      Promise.resolve(handle.close()).then(resolve, reject);
    };

    signals.once("SIGINT", shutdown);
    signals.once("SIGTERM", shutdown);
  });
}
