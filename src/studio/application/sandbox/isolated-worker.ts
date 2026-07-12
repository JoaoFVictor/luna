import { Worker } from "node:worker_threads";

export type StudioIsolatedWorkerOutcome =
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed" }
  | { readonly kind: "message"; readonly message: unknown }
  | { readonly kind: "timeout" };

export function studioWorkerUrl(
  ownerModuleUrl: string,
  workerBasename: string
): URL {
  const extension = ownerModuleUrl.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`${workerBasename}${extension}`, ownerModuleUrl);
}

export async function runStudioIsolatedWorker(input: {
  readonly entry: URL;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly workerData: unknown;
}): Promise<StudioIsolatedWorkerOutcome> {
  if (input.signal.aborted) {
    return { kind: "cancelled" };
  }

  let worker: Worker;
  try {
    worker = new Worker(input.entry, {
      argv: [],
      env: {},
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 4
      },
      workerData: input.workerData
    });
  } catch {
    return { kind: "failed" };
  }

  return await new Promise<StudioIsolatedWorkerOutcome>((resolve) => {
    let settled = false;
    const finish = (
      result: StudioIsolatedWorkerOutcome,
      terminate: boolean
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", onAbort);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      if (terminate) {
        void worker.terminate().then(
          () => resolve(result),
          () => resolve(result)
        );
      } else {
        resolve(result);
      }
    };
    const onAbort = () => finish({ kind: "cancelled" }, true);
    const onMessage = (message: unknown) =>
      finish({ kind: "message", message }, true);
    const onError = () => finish({ kind: "failed" }, true);
    const onExit = () => finish({ kind: "failed" }, false);
    const timeout = setTimeout(
      () => finish({ kind: "timeout" }, true),
      input.timeoutMs
    );

    input.signal.addEventListener("abort", onAbort, { once: true });
    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);

    if (input.signal.aborted) {
      onAbort();
    }
  });
}
