import type { NativeLunaPlatformRegistrations } from "../../../platform/native/native-platform-registrations.js";
import {
  createNativeProviderBuiltIns,
  nativeBuiltInMetadata
} from "../../../platform/native/native-built-ins.js";
import { createStudioCapabilityCatalog } from "../../application/catalog/capability-catalog.js";

type NativeStudioCatalogPlatform = Pick<
  NativeLunaPlatformRegistrations,
  | "capabilityRegistry"
  | "workflowBuiltIns"
  | "taskProviderBuiltIns"
>;

export function createNativeStudioCapabilityCatalog(
  platform: NativeStudioCatalogPlatform
) {
  const builtIns = createNativeProviderBuiltIns({
    workflowBuiltIns: platform.workflowBuiltIns,
    taskProviderBuiltIns: platform.taskProviderBuiltIns,
    capabilityRegistry: platform.capabilityRegistry
  });
  return createStudioCapabilityCatalog(platform.capabilityRegistry, {
    builtInMetadata: (id) =>
      nativeBuiltInMetadata(builtIns.builtInStepRegistry, {
        capability_id: id
      })
  });
}
