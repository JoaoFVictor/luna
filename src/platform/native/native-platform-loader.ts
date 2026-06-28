import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadYamlFile } from "../../core/config/loader.js";
import {
  AppConfigSchema,
  type AppConfig
} from "../../core/config/schemas.js";
import {
  createNativeLunaPlatformRegistrations
} from "./native-platform-registrations.js";
import {
  defineNativePlatformPlugins,
  nativePlatformPluginDefinitions,
  type NativePlatformPlugin
} from "./native-platform-plugins.js";
import {
  runNativeWorkflowTarget
} from "./native-workflow-runner.js";
import type { LunaPlatform } from "./native-platform.js";

export type NativePlatformLoadInput = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly app?: AppConfig;
};

export type NativePlatformPluginModuleError = Error & {
  code: "native_plugin_module_invalid";
};

function nativePluginModuleError(message: string): NativePlatformPluginModuleError {
  const error = new Error(message) as NativePlatformPluginModuleError;
  error.code = "native_plugin_module_invalid";
  return error;
}

export async function loadNativeLunaPlatform({
  projectRoot,
  configRoot,
  app
}: NativePlatformLoadInput): Promise<LunaPlatform> {
  const loadedApp = app ?? await loadYamlFile(
    path.join(configRoot, "app.yaml"),
    AppConfigSchema
  );
  const configuredPlugins = await loadConfiguredNativePlatformPlugins({
    projectRoot,
    configRoot,
    app: loadedApp
  });
  const registrations =
    configuredPlugins.length === 0
      ? createNativeLunaPlatformRegistrations()
      : createNativeLunaPlatformRegistrations({
          plugins: defineNativePlatformPlugins([
            ...nativePlatformPluginDefinitions,
            ...configuredPlugins
          ])
        });

  return {
    ...registrations,
    runWorkflow: async (input) =>
      await runNativeWorkflowTarget(input, { platform: registrations })
  };
}

async function loadConfiguredNativePlatformPlugins({
  projectRoot,
  configRoot,
  app
}: {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly app: AppConfig;
}): Promise<NativePlatformPlugin[]> {
  const pluginGroups = await Promise.all(
    (app.plugins ?? []).map((plugin) =>
      loadNativePlatformPluginModule(plugin.module, {
        projectRoot,
        configRoot
      })
    )
  );

  return pluginGroups.flat();
}

async function loadNativePlatformPluginModule(
  specifier: string,
  {
    projectRoot,
    configRoot
  }: {
    readonly projectRoot: string;
    readonly configRoot: string;
  }
): Promise<NativePlatformPlugin[]> {
  const module = await import(resolvePluginModuleSpecifier(specifier, {
    projectRoot,
    configRoot
  })) as Record<string, unknown>;
  const exported =
    module.default ??
    module.nativePlatformPlugin ??
    module.nativePlatformPlugins;

  if (exported === undefined) {
    throw nativePluginModuleError(
      `Native plugin module ${specifier} must export default, nativePlatformPlugin, or nativePlatformPlugins`
    );
  }

  const plugins = Array.isArray(exported) ? exported : [exported];
  for (const plugin of plugins) {
    if (!isNativePlatformPlugin(plugin)) {
      throw nativePluginModuleError(
        `Native plugin module ${specifier} exported an invalid plugin`
      );
    }
  }

  return plugins;
}

function resolvePluginModuleSpecifier(
  specifier: string,
  {
    projectRoot,
    configRoot
  }: {
    readonly projectRoot: string;
    readonly configRoot: string;
  }
): string {
  if (specifier.startsWith("file:")) {
    return specifier;
  }

  if (path.isAbsolute(specifier)) {
    return pathToFileURL(specifier).href;
  }

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return pathToFileURL(path.resolve(configRoot, specifier)).href;
  }

  if (specifier.startsWith("~/")) {
    return pathToFileURL(path.resolve(projectRoot, specifier.slice(2))).href;
  }

  return specifier;
}

function isNativePlatformPlugin(candidate: unknown): candidate is NativePlatformPlugin {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { readonly id?: unknown }).id === "string"
  );
}
