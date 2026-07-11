import {
  type InputAdapterRegistry
} from "../../../adapters/registry.js";
import type {
  AdapterInput,
  RegisteredInputAdapter
} from "../../../adapters/types.js";
import type { NativeLunaPlatformRegistrations } from "../../../platform/native/native-platform-registrations.js";
import {
  loadNativeWorkflowDefinition,
  loadWorkflowRuntimeConfig
} from "../../../platform/native/native-run-context.js";
import type {
  StudioInstalledRunDefinition,
  StudioInstalledRunDefinitionPort,
  StudioRunAdapterInputResolverPort
} from "../../application/runs/launch-facade.js";
import {
  captureNativeStudioRunSnapshot,
  withMaterializedNativeStudioRunSnapshot
} from "./run-definition-snapshot.js";
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
  implements
    StudioRunAdapterInputResolverPort,
    StudioInstalledRunDefinitionPort
{
  readonly #projectRoot: string;
  readonly #configRoot: string;
  readonly #registry: InputAdapterRegistry<RegisteredInputAdapter>;
  readonly #platform: Pick<NativeLunaPlatformRegistrations, "capabilityRegistry">;
  readonly #adapterContext: ReturnType<typeof createNativeStudioAdapterContext>;

  constructor(options: NativeStudioRunLaunchInputOptions) {
    this.#projectRoot = options.projectRoot;
    this.#configRoot = options.configRoot;
    this.#registry = options.platform.inputAdapterRegistry;
    this.#platform = options.platform;
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

  async load(workflowId: string): Promise<StudioInstalledRunDefinition> {
    const snapshot = await captureNativeStudioRunSnapshot({
      projectRoot: this.#projectRoot,
      configRoot: this.#configRoot,
      workflowId
    });
    return await withMaterializedNativeStudioRunSnapshot(
      snapshot,
      async (roots) => {
        const workflow = await loadNativeWorkflowDefinition({
          projectRoot: roots.projectRoot,
          workflowId,
          platform: this.#platform
        });
        const config = await loadWorkflowRuntimeConfig({
          workflow,
          configRoot: roots.configRoot
        });
        return {
          workflowRevision: workflow.revision,
          definitionBundleHash: snapshot.bundle_hash,
          config
        };
      }
    );
  }
}
