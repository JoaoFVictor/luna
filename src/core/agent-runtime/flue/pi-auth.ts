import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { registerProvider as defaultRegisterProvider } from "@flue/runtime";
import { getOAuthApiKey as defaultGetOAuthApiKey } from "@earendil-works/pi-ai/oauth";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { loadYamlFile } from "../../config/loader.js";
import { resolveModelProfiles } from "../../config/models.js";
import { ModelsConfigSchema } from "../../config/schemas.js";

type PiAuth = Record<string, OAuthCredentials>;

type OAuthResult = {
  apiKey: string;
  newCredentials: OAuthCredentials;
};

export type PiAuthOptions = {
  authPath?: string;
  getOAuthApiKey?: (
    providerId: string,
    auth: PiAuth
  ) => Promise<OAuthResult | null>;
};

export type RegisterPiOAuthProviderOptions = PiAuthOptions & {
  registerProvider?: (
    providerId: string,
    registration: { apiKey: string }
  ) => void;
};

export type RegisterConfiguredPiOAuthProvidersOptions = {
  configRoot: string;
  env?: NodeJS.ProcessEnv;
  registerPiOAuthProvider?: (providerId: string) => Promise<void>;
};

export type PiAuthError = Error & {
  code: "pi_auth_missing" | "pi_auth_invalid";
  cause?: unknown;
};

function piAuthError(
  code: PiAuthError["code"],
  message: string,
  cause?: unknown
): PiAuthError {
  const error = new Error(message, { cause }) as PiAuthError;
  error.code = code;
  error.cause = cause;

  return error;
}

function defaultAuthPath(): string {
  return path.join(process.cwd(), "auth.json");
}

async function loadAuthFile(authPath: string): Promise<PiAuth> {
  let content: string;
  try {
    content = await readFile(authPath, "utf8");
  } catch (cause) {
    throw piAuthError(
      "pi_auth_missing",
      `Pi OAuth credentials not found at ${authPath}. Run: npx @earendil-works/pi-ai login openai-codex`,
      cause
    );
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("auth.json must be an object");
    }

    return parsed as PiAuth;
  } catch (cause) {
    throw piAuthError("pi_auth_invalid", `Invalid Pi auth file: ${authPath}`, cause);
  }
}

export async function loadPiOAuthApiKey(
  providerId: string,
  options: PiAuthOptions = {}
): Promise<string> {
  const authPath = options.authPath ?? defaultAuthPath();
  const getOAuthApiKey = options.getOAuthApiKey ?? defaultGetOAuthApiKey;
  const auth = await loadAuthFile(authPath);
  const authForRefresh = JSON.parse(JSON.stringify(auth)) as PiAuth;
  const result = await getOAuthApiKey(providerId, authForRefresh);

  if (result === null) {
    throw piAuthError(
      "pi_auth_missing",
      `Pi OAuth credentials for ${providerId} not found in ${authPath}. Run: npx @earendil-works/pi-ai login ${providerId}`
    );
  }

  auth[providerId] = {
    type: "oauth",
    ...result.newCredentials
  };
  await writeFile(authPath, JSON.stringify(auth, null, 2), "utf8");

  return result.apiKey;
}

export async function registerPiOAuthProvider(
  providerId: string,
  options: RegisterPiOAuthProviderOptions = {}
): Promise<void> {
  const apiKey = await loadPiOAuthApiKey(providerId, options);
  const registerProvider = options.registerProvider ?? defaultRegisterProvider;

  registerProvider(providerId, { apiKey });
}

export async function registerConfiguredPiOAuthProviders({
  configRoot,
  env = process.env,
  registerPiOAuthProvider: registerProviderForPi = registerPiOAuthProvider
}: RegisterConfiguredPiOAuthProvidersOptions): Promise<void> {
  const models = await loadYamlFile(
    path.join(configRoot, "models.yaml"),
    ModelsConfigSchema
  );
  const profiles = resolveModelProfiles(models, env);
  const providers = new Set(
    Object.values(profiles)
      .map((profile) => profile.model.split("/", 1)[0])
      .filter((provider) => provider === "openai-codex")
  );

  for (const provider of providers) {
    await registerProviderForPi(provider);
  }
}
