import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getOAuthApiKey as defaultGetOAuthApiKey,
  type OAuthCredentials
} from "@earendil-works/pi-ai/oauth";
import { loadYamlFile } from "../../core/config/loader.js";
import { resolveModelProfiles } from "../../core/config/models.js";
import { ModelsConfigSchema } from "../../core/config/schemas.js";

type CredentialsByProvider = Record<string, OAuthCredentials>;

type GetOAuthApiKey = (
  providerId: string,
  credentials: CredentialsByProvider
) => Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null>;

type RegisterProvider = (
  providerId: string,
  options: { readonly apiKey: string }
) => void;

type PiAuthErrorCode = "pi_auth_missing" | "pi_auth_invalid";

class PiAuthError extends Error {
  readonly code: PiAuthErrorCode;

  constructor(code: PiAuthErrorCode, message: string) {
    super(message);
    this.name = "PiAuthError";
    this.code = code;
  }
}

function defaultAuthPath(): string {
  return path.join(process.env.HOME ?? ".", ".config", "pi-ai", "auth.json");
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
  options: {
    readonly authPath?: string;
    readonly getOAuthApiKey?: GetOAuthApiKey;
  } = {}
): Promise<string> {
  const authPath = options.authPath ?? defaultAuthPath();
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
  options: {
    readonly authPath?: string;
    readonly getOAuthApiKey?: GetOAuthApiKey;
    readonly registerProvider?: RegisterProvider;
  } = {}
): Promise<void> {
  const apiKey = await loadPiOAuthApiKey(providerId, options);
  options.registerProvider?.(providerId, { apiKey });
}

export async function registerConfiguredPiOAuthProviders({
  configRoot,
  env = process.env,
  registerPiOAuthProvider: registerProvider = registerPiOAuthProvider
}: {
  readonly configRoot: string;
  readonly env?: Record<string, string | undefined>;
  readonly registerPiOAuthProvider?: (providerId: string) => Promise<void>;
}): Promise<void> {
  const profiles = resolveModelProfiles(
    await loadYamlFile(path.join(configRoot, "models.yaml"), ModelsConfigSchema),
    env
  );
  const providers = new Set(
    Object.values(profiles)
      .map((profile) => profile.provider ?? providerFromModel(profile.model))
      .filter((provider): provider is string => provider === "openai-codex")
  );

  await Promise.all([...providers].map((provider) => registerProvider(provider)));
}
