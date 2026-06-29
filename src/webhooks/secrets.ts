import type { LunaAuthEnv } from "../core/auth/root.js";
import { loadLunaAuthFile } from "../core/auth/luna-auth-file.js";
import { webhookConfigInvalid } from "./errors.js";

export async function loadWebhookSecrets(
  projectRoot: string,
  env: LunaAuthEnv = process.env
): Promise<unknown> {
  try {
    return await loadLunaAuthFile(projectRoot, env);
  } catch (cause) {
    throw webhookConfigInvalid("Failed to load webhook secrets", cause);
  }
}

export function resolveSecretRef(root: unknown, ref: string): string {
  const segments = ref.split(".");
  let current = root;

  for (const segment of segments) {
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      throw webhookConfigInvalid(`Missing webhook secret for ref: ${ref}`);
    }

    current = (current as Record<string, unknown>)[segment];
  }

  if (typeof current !== "string" || current.length === 0) {
    throw webhookConfigInvalid(`Missing webhook secret for ref: ${ref}`);
  }

  return current;
}

export async function resolveProviderWebhookSecret(args: {
  projectRoot: string;
  secretRef: string;
  env?: LunaAuthEnv;
}): Promise<string> {
  const secrets = await loadWebhookSecrets(args.projectRoot, args.env);

  return resolveSecretRef(secrets, args.secretRef);
}
