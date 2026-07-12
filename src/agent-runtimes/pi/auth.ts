import path from "node:path";
import {
  defaultProviderAuthContext,
  type Models
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  resolveLunaAuthRoot,
  type LunaAuthEnv
} from "../../core/auth/root.js";
import {
  createPiCredentialStore as createFileCredentialStore,
  type PiCredentialStoreOptions
} from "./credential-store.js";

export type PiModelsOptions = {
  readonly projectRoot?: string;
  readonly env?: Record<string, string | undefined>;
};

export function piAuthPath(
  projectRoot = process.cwd(),
  env: LunaAuthEnv = process.env
): string {
  return path.join(resolveLunaAuthRoot(projectRoot, env), "pi-ai", "auth.json");
}

export function createPiCredentialStore(
  options: PiCredentialStoreOptions
) {
  return createFileCredentialStore(options);
}

/**
 * Creates the provider-neutral pi-ai model registry used by Luna.
 *
 * All built-in providers are registered. Provider-specific API keys, OAuth,
 * refresh and request details stay inside pi-ai's provider implementations;
 * Luna only supplies the persistent credential store and project environment.
 */
export function createPiModels(options: PiModelsOptions = {}): Models {
  const projectRoot = options.projectRoot ?? process.cwd();
  const env = options.env ?? process.env;
  const defaultAuthContext = defaultProviderAuthContext();
  const lunaAuthEnv: LunaAuthEnv = {
    LUNA_AUTH_ROOT: env.LUNA_AUTH_ROOT
  };

  return builtinModels({
    credentials: createFileCredentialStore({
      authPath: piAuthPath(projectRoot, lunaAuthEnv)
    }),
    authContext: {
      env: async (name) => {
        const value = env[name];
        return typeof value === "string" && value.trim() !== ""
          ? value
          : await defaultAuthContext.env(name);
      },
      fileExists: defaultAuthContext.fileExists
    }
  });
}
