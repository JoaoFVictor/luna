import { defaultAdapterContext } from "../../../adapters/registry.js";
import type {
  AdapterContext,
  AdapterInput,
  RegisteredInputAdapter
} from "../../../adapters/types.js";
import type { Invocation } from "../../../core/router/invocation.js";
import {
  StudioAdapterPreviewEffectsSchema,
  StudioAdapterPreviewTimeoutMsSchema,
  type StudioAdapterPreviewEffect
} from "../../contracts/input-routing.js";

export const DEFAULT_NATIVE_STUDIO_ADAPTER_TIMEOUT_MS = 60_000;

export type NativeStudioAdapterLoadPolicy = {
  readonly effects: readonly StudioAdapterPreviewEffect[];
  readonly timeoutMs: number;
};

export function nativeStudioAdapterLoadPolicy(
  adapter: RegisteredInputAdapter
): NativeStudioAdapterLoadPolicy | undefined {
  if (adapter.loadEffects === undefined) {
    return undefined;
  }
  return Object.freeze({
    effects: Object.freeze(
      StudioAdapterPreviewEffectsSchema.parse(adapter.loadEffects)
    ),
    timeoutMs: StudioAdapterPreviewTimeoutMsSchema.parse(
      adapter.loadTimeoutMs ?? DEFAULT_NATIVE_STUDIO_ADAPTER_TIMEOUT_MS
    )
  });
}

export function createNativeStudioAdapterContext(
  projectRoot: string,
  configRoot: string
): AdapterContext {
  return defaultAdapterContext(projectRoot, configRoot);
}

function contextWithSignal(
  context: AdapterContext,
  signal: AbortSignal
): AdapterContext {
  return {
    ...context,
    fetch: async (input, init) => {
      const requestSignal = init?.signal;
      const combined =
        requestSignal === undefined || requestSignal === null
          ? signal
          : AbortSignal.any([signal, requestSignal]);
      return await context.fetch(input, { ...init, signal: combined });
    },
    executeJson: async (command, args, options = {}) => {
      const commandSignal = options.signal === undefined
        ? signal
        : AbortSignal.any([signal, options.signal]);
      return await context.executeJson(command, args, {
        ...options,
        signal: commandSignal
      });
    }
  };
}

export async function loadNativeStudioInputAdapter(
  adapter: RegisteredInputAdapter,
  input: AdapterInput,
  context: AdapterContext,
  signal: AbortSignal
): Promise<Invocation> {
  signal.throwIfAborted();
  return await new Promise<Invocation>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () =>
      finish(() => {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Adapter load was aborted", "AbortError")
        );
      });
    signal.addEventListener("abort", abort, { once: true });

    Promise.resolve(
      adapter.load(input, contextWithSignal(context, signal))
    ).then(
      (invocation) =>
        finish(() => {
          if (invocation.source !== adapter.source) {
            reject(new Error("Registered adapter returned an unexpected source"));
            return;
          }
          resolve(invocation);
        }),
      (cause: unknown) => finish(() => reject(cause))
    );
  });
}

export function nativeStudioAdapterOperationSignal(
  inputSignal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return inputSignal === undefined
    ? timeout
    : AbortSignal.any([inputSignal, timeout]);
}
