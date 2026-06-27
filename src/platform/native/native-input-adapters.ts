import { defineInputAdapters } from "../../adapters/registry.js";
import { nativePlatformExtensions } from "./native-platform-extensions.js";

export const nativeInputAdapterRegistry = defineInputAdapters(
  nativePlatformExtensions.flatMap((extension) => extension.inputAdapters ?? [])
);
