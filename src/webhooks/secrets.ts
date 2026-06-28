import { loadLunaAuthFile } from "../providers/auth.js";
import { webhookConfigInvalid } from "./errors.js";

export async function loadWebhookSecrets(projectRoot: string): Promise<unknown> {
  try {
    return await loadLunaAuthFile(projectRoot);
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
}): Promise<string> {
  const secrets = await loadWebhookSecrets(args.projectRoot);

  return resolveSecretRef(secrets, args.secretRef);
}
