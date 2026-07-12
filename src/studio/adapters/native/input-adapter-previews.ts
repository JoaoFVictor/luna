import type { InputAdapterRegistry } from "../../../adapters/registry.js";
import type { RegisteredInputAdapter } from "../../../adapters/types.js";
import {
  defineStudioAdapterPreviewPort,
  type StudioAdapterPreviewPort,
  type StudioAdapterPreviewRegistration
} from "../../application/inputs/adapter-preview-port.js";
import {
  createNativeStudioAdapterContext,
  loadNativeStudioInputAdapter,
  nativeStudioAdapterLoadPolicy
} from "./input-adapter-execution.js";

export function createNativeStudioAdapterPreviews(options: {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly registry: InputAdapterRegistry<RegisteredInputAdapter>;
}): StudioAdapterPreviewPort {
  const context = createNativeStudioAdapterContext(
    options.projectRoot,
    options.configRoot
  );
  const registrations: StudioAdapterPreviewRegistration[] = [];

  for (const adapterId of options.registry.ids()) {
    const adapter = options.registry.require(adapterId);
    const policy = nativeStudioAdapterLoadPolicy(adapter);
    if (policy === undefined) {
      continue;
    }
    registrations.push({
      adapterId,
      effects: policy.effects,
      timeoutMs: policy.timeoutMs,
      preview: async (input, operation) =>
        await loadNativeStudioInputAdapter(
          adapter,
          input,
          context,
          operation.signal
        )
    });
  }

  return defineStudioAdapterPreviewPort(options.registry, registrations);
}
