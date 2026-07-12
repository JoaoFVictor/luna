import {
  type InputAdapterRegistry
} from "../../../adapters/registry.js";
import type {
  AdapterInput,
  RegisteredInputAdapter
} from "../../../adapters/types.js";
import type { NativeLunaPlatformRegistrations } from "../../../platform/native/native-platform-registrations.js";
import type {
  StudioRunAdapterInputResolverPort
} from "../../application/runs/launch-facade.js";
import {
  createNativeStudioAdapterContext,
  loadNativeStudioInputAdapter,
  nativeStudioAdapterLoadPolicy,
  nativeStudioAdapterOperationSignal
} from "./input-adapter-execution.js";

type NativeRunInputPlatform = Pick<
  NativeLunaPlatformRegistrations,
  "inputAdapterRegistry" | "capabilityRegistry"
>;

export type NativeStudioRunLaunchInputOptions = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly platform: NativeRunInputPlatform;
};

export class NativeStudioRunLaunchInput
  implements StudioRunAdapterInputResolverPort
{
  readonly #registry: InputAdapterRegistry<RegisteredInputAdapter>;
  readonly #adapterContext: ReturnType<typeof createNativeStudioAdapterContext>;

  constructor(options: NativeStudioRunLaunchInputOptions) {
    this.#registry = options.platform.inputAdapterRegistry;
    this.#adapterContext = createNativeStudioAdapterContext(
      options.projectRoot,
      options.configRoot
    );
  }

  loadPolicy(adapterId: string) {
    const adapter = this.#registry.get(adapterId);
    return adapter === undefined
      ? undefined
      : nativeStudioAdapterLoadPolicy(adapter);
  }

  async resolve(
    adapterId: string,
    input: AdapterInput,
    signal?: AbortSignal
  ) {
    const adapter = this.#registry.get(adapterId);
    if (adapter === undefined) {
      return undefined;
    }
    const policy = nativeStudioAdapterLoadPolicy(adapter);
    if (policy === undefined) {
      return undefined;
    }
    const operationSignal = nativeStudioAdapterOperationSignal(
      signal,
      policy.timeoutMs
    );
    return await loadNativeStudioInputAdapter(
      adapter,
      input,
      this.#adapterContext,
      operationSignal
    );
  }

}
