import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getOAuthApiKey as defaultGetOAuthApiKey,
  type OAuthCredentials
} from "@earendil-works/pi-ai/oauth";
import { loadYamlFile } from "../../core/config/loader.js";
import { resolveModelProfiles } from "../../core/config/models.js";
import { ModelsConfigSchema } from "../../core/config/schemas.js";
import {
  resolveLunaAuthRoot,
  type LunaAuthEnv
} from "../../core/auth/root.js";

type CredentialsByProvider = Record<string, OAuthCredentials>;

type GetOAuthApiKey = (
  providerId: string,
  credentials: CredentialsByProvider
) => Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null>;

type RegisterProvider = (
  providerId: string,
  options: { readonly apiKey: string }
) => void;

type PiAuthOptions = {
  readonly authPath?: string;
  readonly projectRoot?: string;
  readonly env?: LunaAuthEnv;
  readonly getOAuthApiKey?: GetOAuthApiKey;
};

type RegisterPiOAuthProviderOptions = PiAuthOptions & {
  readonly registerProvider?: RegisterProvider;
};

type RegisterConfiguredPiOAuthProvidersOptions = {
  readonly projectRoot?: string;
  readonly configRoot: string;
  readonly env?: Record<string, string | undefined>;
  readonly registerPiOAuthProvider?: (
    providerId: string,
    options?: Pick<PiAuthOptions, "projectRoot" | "env">
  ) => Promise<void>;
};

const apiKeysByProvider = new Map<string, string>();

type PiAuthErrorCode = "pi_auth_missing" | "pi_auth_invalid";

class PiAuthError extends Error {
  readonly code: PiAuthErrorCode;

  constructor(code: PiAuthErrorCode, message: string) {
    super(message);
    this.name = "PiAuthError";
    this.code = code;
  }
}

function defaultAuthPath(
  projectRoot = process.cwd(),
  env: LunaAuthEnv = process.env
): string {
  return path.join(resolveLunaAuthRoot(projectRoot, env), "pi-ai", "auth.json");
}

function isCredentialsByProvider(value: unknown): value is CredentialsByProvider {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readCredentials(authPath: string): Promise<CredentialsByProvider> {
  const parsed = JSON.parse(await readFile(authPath, "utf8")) as unknown;
  if (!isCredentialsByProvider(parsed)) {
    throw new PiAuthError("pi_auth_invalid", `Pi OAuth credentials are invalid at ${authPath}`);
  }

  return parsed;
}

function providerFromModel(model: string): string | undefined {
  const separator = model.indexOf("/");
  return separator <= 0 ? undefined : model.slice(0, separator);
}

export async function loadPiOAuthApiKey(
  providerId: string,
  options: PiAuthOptions = {}
): Promise<string> {
  const authPath = options.authPath ?? defaultAuthPath(options.projectRoot, options.env);
  const getOAuthApiKey = options.getOAuthApiKey ?? defaultGetOAuthApiKey;
  const credentials = await readCredentials(authPath);

  if (credentials[providerId] === undefined) {
    throw new PiAuthError(
      "pi_auth_missing",
      `Pi OAuth credentials for ${providerId} not found in ${authPath}. Run: npx @earendil-works/pi-ai login ${providerId}`
    );
  }

  const resolved = await getOAuthApiKey(providerId, credentials);
  if (resolved === null) {
    throw new PiAuthError(
      "pi_auth_missing",
      `Pi OAuth credentials for ${providerId} not found in ${authPath}. Run: npx @earendil-works/pi-ai login ${providerId}`
    );
  }

  const updated = {
    ...credentials,
    [providerId]: resolved.newCredentials
  };
  await writeFile(authPath, `${JSON.stringify(updated, null, 2)}\n`);

  return resolved.apiKey;
}

export async function registerPiOAuthProvider(
  providerId: string,
  options: RegisterPiOAuthProviderOptions = {}
): Promise<void> {
  const apiKey = await loadPiOAuthApiKey(providerId, options);
  const registerProvider = options.registerProvider ?? registerPiProviderApiKey;
  registerProvider(providerId, { apiKey });
}

export function registerPiProviderApiKey(
  providerId: string,
  options: { readonly apiKey: string }
): void {
  apiKeysByProvider.set(providerId, options.apiKey);
}

export function registeredPiProviderApiKey(providerId: string): string | undefined {
  return apiKeysByProvider.get(providerId);
}

export async function registerConfiguredPiOAuthProviders({
  projectRoot = process.cwd(),
  configRoot,
  env = process.env,
  registerPiOAuthProvider: registerProvider = registerPiOAuthProvider
}: RegisterConfiguredPiOAuthProvidersOptions): Promise<void> {
  const profiles = resolveModelProfiles(
    await loadYamlFile(path.join(configRoot, "models.yaml"), ModelsConfigSchema),
    env
  );
  const providers = new Set(
    Object.values(profiles)
      .map((profile) => profile.provider ?? providerFromModel(profile.model))
      .filter((provider): provider is string => provider === "openai-codex")
  );

  await Promise.all(
    [...providers].map((provider) => registerProvider(provider, { projectRoot, env }))
  );
}
